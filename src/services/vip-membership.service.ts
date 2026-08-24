import { CoinTxType, LevelType, VipMembershipTier } from '@prisma/client'
import { prisma } from '../config/database'
import { RedisKeys, VIPM_ACTIVE_INACTIVE_TTL, VIPM_ACTIVE_TTL_MAX } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { cacheService } from './cache.service'
import { cacheRedisService } from './cacheRedis.service'
import { vipMembershipRepository } from '../repositories/vipMembership.repository'
import {
  enqueueVipMembershipExpiry,
  removeVipMembershipExpiry,
} from '../queues/vip-membership.queue'
import { utcDateString } from '../utils/datetime'
import { redisClient } from '../config/redis'
import {
  assertWithinCap,
  computeProposedExpiresAt,
  DIAMOND_COST,
  DIAMOND_PERIOD_DAYS,
  fanSpendIncrementForGift,
  resolveVipDisplayState,
  SVIP_COST,
  SVIP_PERIOD_DAYS,
  VIP_DAILY_GRANT_COINS,
  VIP_DURATION_CAP_DAYS,
} from './vip-membership.helpers'
import { syncLevelCacheFromApplyResult, type LevelApplyResult } from './user-level.service'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

export {
  DIAMOND_COST,
  SVIP_COST,
  DIAMOND_PERIOD_DAYS,
  SVIP_PERIOD_DAYS,
  VIP_DAILY_GRANT_COINS,
  VIP_DURATION_CAP_DAYS,
  computeProposedExpiresAt,
  assertWithinCap,
  fanSpendIncrementForGift,
}

export type VipMembershipMeDto = {
  isActive: boolean
  tier?: VipMembershipTier
  expiresAt?: string
  daysRemaining: number
  dailyClaimAvailable: boolean
  lastClaimedAt?: string
  vipExclusiveProfileCard: boolean
  vipDistinguishedLogo: boolean
  vipExclusiveMessageBackground: boolean
  vipSpecialEntryEffect: boolean
  vipPreventBeingKicked: boolean
  vipLiveTranslationEnabled: boolean
}

export type VipMembershipCardDto = {
  isActive: boolean
  tier?: VipMembershipTier
  expiresAt?: string
  vipExclusiveProfileCard: boolean
  vipDistinguishedLogo: boolean
  vipExclusiveMessageBackground: boolean
  vipSpecialEntryEffect: boolean
  vipPreventBeingKicked: boolean
  vipLiveTranslationEnabled: boolean
}

function cacheKey(userId: string) {
  return RedisKeys.vipmActive(userId)
}

async function getDisplayTier(
  userId: string,
  now: Date = new Date(),
): Promise<VipMembershipTier | null> {
  const rows = await vipMembershipRepository.listPurchasesForDisplay([userId])
  return resolveVipDisplayState(rows, now).displayTier
}

async function getDisplayStateByUserIds(
  userIds: string[],
  now: Date = new Date(),
): Promise<Map<string, ReturnType<typeof resolveVipDisplayState>>> {
  const out = new Map<string, ReturnType<typeof resolveVipDisplayState>>()
  const rows = await vipMembershipRepository.listPurchasesForDisplay(userIds)
  const byUser = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byUser.get(row.userId)
    if (list) list.push(row)
    else byUser.set(row.userId, [row])
  }
  for (const id of userIds) {
    out.set(id, resolveVipDisplayState(byUser.get(id) ?? [], now))
  }
  return out
}

async function getDisplayTierByUserIds(
  userIds: string[],
  now: Date = new Date(),
): Promise<Map<string, VipMembershipTier>> {
  const states = await getDisplayStateByUserIds(userIds, now)
  const out = new Map<string, VipMembershipTier>()
  for (const [id, state] of states) {
    if (state.displayTier) out.set(id, state.displayTier)
  }
  return out
}

/** `/users/me` assembled + search-card caches embed `vipMembership.tier`. */
async function bustProfileVipCaches(userId: string): Promise<void> {
  await cacheRedisService.del(RedisKeys.userMeAssembled(userId), RedisKeys.userSearchCard(userId))
}

function cacheTtlSec(expiresAt: Date, cacheUntil?: Date | null): number {
  const until =
    cacheUntil != null && cacheUntil.getTime() < expiresAt.getTime() ? cacheUntil : expiresAt
  return Math.min(
    VIPM_ACTIVE_TTL_MAX,
    Math.max(1, Math.floor((until.getTime() - Date.now()) / 1000)),
  )
}

async function writeMembershipCache(args: {
  userId: string
  isActive: boolean
  expiresAt: Date | null
  tier: VipMembershipTier | null
  cacheUntil?: Date | null
}): Promise<void> {
  const key = cacheKey(args.userId)
  if (!args.isActive || !args.expiresAt || args.expiresAt.getTime() <= Date.now() || !args.tier) {
    await cacheService.set(key, 'null', VIPM_ACTIVE_INACTIVE_TTL)
    return
  }
  await cacheService.set(
    key,
    JSON.stringify({
      tier: args.tier,
      expiresAt: args.expiresAt.toISOString(),
    }),
    cacheTtlSec(args.expiresAt, args.cacheUntil),
  )
}

function parseActiveFromCache(raw: string | null): {
  active: boolean
  expiresAt: Date | null
  tier: VipMembershipTier | null
} | null {
  if (raw === null || raw === undefined) return null
  if (raw === 'null') return { active: false, expiresAt: null, tier: null }
  try {
    const p = JSON.parse(raw) as { tier?: VipMembershipTier; expiresAt?: string }
    if (!p?.expiresAt || typeof p.expiresAt !== 'string') {
      return { active: false, expiresAt: null, tier: null }
    }
    const exp = new Date(p.expiresAt)
    if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now()) {
      return { active: false, expiresAt: exp, tier: p.tier ?? null }
    }
    return {
      active: true,
      expiresAt: exp,
      tier: p.tier ?? null,
    }
  } catch {
    return null
  }
}

export const vipMembershipService = {
  tierConfig(tier: VipMembershipTier): {
    periodDays: number
    coinCost: bigint
  } {
    if (tier === VipMembershipTier.DIAMOND) {
      return { periodDays: DIAMOND_PERIOD_DAYS, coinCost: DIAMOND_COST }
    }
    return { periodDays: SVIP_PERIOD_DAYS, coinCost: SVIP_COST }
  },

  async refreshCache(userId: string): Promise<void> {
    const state = await vipMembershipRepository.getMembershipState(userId)
    const display = state.isActive
      ? resolveVipDisplayState(
          await vipMembershipRepository.listPurchasesForDisplay([userId]),
          new Date(),
        )
      : null
    await writeMembershipCache({
      userId,
      isActive: state.isActive,
      expiresAt: state.expiresAt,
      tier: display?.displayTier ?? null,
      cacheUntil: display?.displayExpiresAt ?? null,
    })
  },

  async hasActive(userId: string): Promise<boolean> {
    const key = cacheKey(userId)
    const cached = await cacheService.get(key)
    const parsed = parseActiveFromCache(cached)
    if (parsed !== null) {
      return parsed.active
    }

    const state = await vipMembershipRepository.getMembershipState(userId)
    const display = state.isActive
      ? resolveVipDisplayState(
          await vipMembershipRepository.listPurchasesForDisplay([userId]),
          new Date(),
        )
      : null
    await writeMembershipCache({
      userId,
      isActive: state.isActive,
      expiresAt: state.expiresAt,
      tier: display?.displayTier ?? null,
      cacheUntil: display?.displayExpiresAt ?? null,
    })
    return state.isActive
  },

  async hasActiveBulk(userIds: string[]): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>()
    if (userIds.length === 0) return out

    const keys = userIds.map(cacheKey)
    const raw = await redisClient.mget(...keys)

    const misses: string[] = []
    for (let i = 0; i < userIds.length; i++) {
      const id = userIds[i]!
      const v = raw[i] ?? null
      const parsed = parseActiveFromCache(v)
      if (parsed === null) {
        misses.push(id)
        continue
      }
      out.set(id, parsed.active)
    }

    if (misses.length > 0) {
      const dbMap = await vipMembershipRepository.getMembershipStateBulk(misses)
      const activeIds = [...dbMap.entries()].filter(([, s]) => s.isActive).map(([id]) => id)
      const displayByUser = await getDisplayStateByUserIds(activeIds)

      const pipe = redisClient.pipeline()
      for (const id of misses) {
        const st = dbMap.get(id)!
        const display = displayByUser.get(id)
        const tier = st.isActive ? (display?.displayTier ?? null) : null
        out.set(id, st.isActive)
        if (!st.isActive || !st.expiresAt || !tier || st.expiresAt.getTime() <= Date.now()) {
          pipe.set(cacheKey(id), 'null', 'EX', VIPM_ACTIVE_INACTIVE_TTL)
        } else {
          pipe.set(
            cacheKey(id),
            JSON.stringify({
              tier,
              expiresAt: st.expiresAt.toISOString(),
            }),
            'EX',
            cacheTtlSec(st.expiresAt, display?.displayExpiresAt),
          )
        }
      }
      try {
        await pipe.exec()
      } catch {
        /* best-effort cache fill */
      }
    }

    return out
  },

  async getMembership(userId: string): Promise<VipMembershipMeDto> {
    const state = await vipMembershipRepository.getMembershipState(userId)
    const tier = state.isActive ? ((await getDisplayTier(userId)) ?? undefined) : undefined
    const now = new Date()
    const daysRemaining =
      state.expiresAt && state.expiresAt > now
        ? Math.max(0, Math.ceil((state.expiresAt.getTime() - now.getTime()) / 86_400_000))
        : 0

    const claimDate = new Date(`${utcDateString(now)}T00:00:00.000Z`)
    const todayClaim = await vipMembershipRepository.getDailyClaim(userId, claimDate)
    const last = await vipMembershipRepository.getLastDailyClaim(userId)

    const isActive = state.isActive
    const cosmetic = isActive
    return {
      isActive,
      tier,
      expiresAt: state.expiresAt?.toISOString(),
      daysRemaining,
      dailyClaimAvailable: isActive && !todayClaim,
      lastClaimedAt: last?.claimedAt.toISOString(),
      vipExclusiveProfileCard: cosmetic,
      vipDistinguishedLogo: cosmetic,
      vipExclusiveMessageBackground: cosmetic,
      vipSpecialEntryEffect: cosmetic,
      vipPreventBeingKicked: cosmetic,
      vipLiveTranslationEnabled: cosmetic,
    }
  },

  async getActiveMembershipSummary(userId: string): Promise<VipMembershipCardDto> {
    const isActive = await this.hasActive(userId)
    if (!isActive) {
      return {
        isActive: false,
        vipExclusiveProfileCard: false,
        vipDistinguishedLogo: false,
        vipExclusiveMessageBackground: false,
        vipSpecialEntryEffect: false,
        vipPreventBeingKicked: false,
        vipLiveTranslationEnabled: false,
      }
    }
    const tier = (await getDisplayTier(userId)) ?? undefined
    const { expiresAt } = await vipMembershipRepository.getMembershipState(userId)
    return {
      isActive: true,
      tier,
      expiresAt: expiresAt?.toISOString(),
      vipExclusiveProfileCard: true,
      vipDistinguishedLogo: true,
      vipExclusiveMessageBackground: true,
      vipSpecialEntryEffect: true,
      vipPreventBeingKicked: true,
      vipLiveTranslationEnabled: true,
    }
  },

  async buildMeVipMembershipBlock(userId: string): Promise<VipMembershipMeDto> {
    return this.getMembership(userId)
  },

  async buildCardBlockBulk(userIds: string[]): Promise<Map<string, VipMembershipCardDto>> {
    const activeMap = await this.hasActiveBulk(userIds)
    const m = new Map<string, VipMembershipCardDto>()
    const activeIdList = userIds.filter((id) => activeMap.get(id) === true)
    const tierByUser = await getDisplayTierByUserIds(activeIdList)
    const states = await vipMembershipRepository.getMembershipStateBulk(userIds)
    for (const id of userIds) {
      const isActive = activeMap.get(id) ?? false
      if (!isActive) {
        m.set(id, {
          isActive: false,
          vipExclusiveProfileCard: false,
          vipDistinguishedLogo: false,
          vipExclusiveMessageBackground: false,
          vipSpecialEntryEffect: false,
          vipPreventBeingKicked: false,
          vipLiveTranslationEnabled: false,
        })
        continue
      }
      const tier = tierByUser.get(id)
      const exp = states.get(id)?.expiresAt
      m.set(id, {
        isActive: true,
        tier,
        expiresAt: exp?.toISOString(),
        vipExclusiveProfileCard: true,
        vipDistinguishedLogo: true,
        vipExclusiveMessageBackground: true,
        vipSpecialEntryEffect: true,
        vipPreventBeingKicked: true,
        vipLiveTranslationEnabled: true,
      })
    }
    return m
  },

  async purchase(
    userId: string,
    tier: VipMembershipTier,
    idempotencyKey: string,
  ): Promise<{
    expiresAt: Date
    coinsPaid: string
    tier: VipMembershipTier
  }> {
    const { periodDays, coinCost } = this.tierConfig(tier)

    let buyerWealthResult: LevelApplyResult | null = null
    // Read Committed + the buyer's COIN wallet FOR UPDATE (inside debit) as the
    // serializer: every purchase for a user debits the same wallet row, so
    // reading the membership state AFTER the debit sees the latest committed
    // stack. Serializable previously aborted concurrent stacks with 40001 500s.
    const runPurchaseTransaction = () =>
      prisma.$transaction(
        async (tx) => {
          // Pre-read only for error precedence (USER_NOT_FOUND / duration cap
          // before INSUFFICIENT_COINS) — the authoritative read happens below,
          // under the wallet lock.
          const preRead = await tx.user.findUnique({
            where: { id: userId },
            select: { vipSubscriptionExpiresAt: true },
          })
          if (!preRead) {
            throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
          }
          const preNow = new Date()
          assertWithinCap(
            computeProposedExpiresAt({
              now: preNow,
              currentExpiresAt: preRead.vipSubscriptionExpiresAt,
              periodDays,
            }),
            preNow,
            VIP_DURATION_CAP_DAYS,
          )

          const { ledgerEntryId, wealthLevelResult } = await coinWalletService.debit(
            userId,
            coinCost,
            CoinTxType.VIP_MEMBERSHIP_PURCHASE,
            tx,
            {
              idempotencyKey,
              description: `VIP membership (${tier})`,
              metadata: { tier, periodDays },
              applyWealthXp: true,
            },
          )
          buyerWealthResult = wealthLevelResult

          const existing = await vipMembershipRepository.findPurchaseByLedgerEntryId(
            ledgerEntryId,
            tx,
          )
          if (existing) {
            return { proposedExpiresAt: existing.expiresAtAfter }
          }

          // Authoritative stacking read — serialized by the wallet lock above.
          const u = await tx.user.findUnique({
            where: { id: userId },
            select: {
              vipSubscriptionExpiresAt: true,
              vipSubscriptionStartAt: true,
            },
          })
          if (!u) {
            throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
          }
          const now = new Date()
          const proposed = computeProposedExpiresAt({
            now,
            currentExpiresAt: u.vipSubscriptionExpiresAt,
            periodDays,
          })
          assertWithinCap(proposed, now, VIP_DURATION_CAP_DAYS)

          await vipMembershipRepository.updateMembershipState(
            {
              userId,
              expiresAt: proposed,
              setStartAt: u.vipSubscriptionStartAt == null ? now : undefined,
              active: true,
            },
            tx,
          )

          await vipMembershipRepository.insertPurchase(
            {
              userId,
              tier,
              periodDays,
              coinCost,
              ledgerEntryId,
              expiresAtBefore: u.vipSubscriptionExpiresAt,
              expiresAtAfter: proposed,
            },
            tx,
          )

          return { proposedExpiresAt: proposed }
        },
        { timeout: INTERACTIVE_TX_TIMEOUT_MS },
      )

    let txResult: { proposedExpiresAt: Date }
    try {
      txResult = await withSerializationRetry(runPurchaseTransaction)
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Parallel duplicate idempotency key: the winner committed between our
        // findByIdempotencyKey check and insert. Re-run once — the debit now
        // replays the existing ledger entry and returns the original result.
        txResult = await runPurchaseTransaction()
      } else {
        throw err
      }
    }
    const { proposedExpiresAt } = txResult

    await walletService.adjustCoinBalanceCache(userId, coinCost)
    await syncLevelCacheFromApplyResult(userId, LevelType.WEALTH, buyerWealthResult)
    await this.refreshCache(userId)
    await bustProfileVipCaches(userId)
    await removeVipMembershipExpiry(userId)
    await enqueueVipMembershipExpiry(userId, proposedExpiresAt)

    return {
      expiresAt: proposedExpiresAt,
      coinsPaid: coinCost.toString(),
      tier,
    }
  },

  async claimDaily(userId: string): Promise<{ amount: string; claimDate: string }> {
    const active = await this.hasActive(userId)
    if (!active) {
      throw new AppError(403, 'VIP membership is not active', 'VIP_NOT_ACTIVE')
    }

    const now = new Date()
    const claimDate = new Date(`${utcDateString(now)}T00:00:00.000Z`)
    const idempotencyKey = `vip-daily-claim:${userId}:${utcDateString(now)}`

    // Read Committed: idempotency is carried by the per-UTC-day ledger key
    // (credit replays existing entries) and the vip_daily_claims PK. A parallel
    // duplicate that races past the existence check hits the PK and maps to the
    // same 409 a sequential duplicate gets (previously a Serializable 40001 500).
    try {
      await withSerializationRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const existing = await tx.vipDailyClaim.findUnique({
              where: { userId_claimDate: { userId, claimDate } },
            })
            if (existing) {
              throw new AppError(409, 'Already claimed today', 'ALREADY_CLAIMED_TODAY')
            }

            // VIP daily grant is NOT a recharge under the spend-based wealth model: no WEALTH XP.
            const credit = await coinWalletService.credit(
              userId,
              VIP_DAILY_GRANT_COINS,
              CoinTxType.VIP_REWARD,
              tx,
              {
                idempotencyKey,
                description: 'VIP daily reward',
                metadata: { claimDate: utcDateString(now) },
                applyWealthCredit: false,
              },
            )

            await vipMembershipRepository.insertDailyClaim(
              {
                userId,
                claimDate,
                coinAmount: VIP_DAILY_GRANT_COINS,
                ledgerEntryId: credit.ledgerEntryId,
              },
              tx,
            )
          },
          { timeout: INTERACTIVE_TX_TIMEOUT_MS },
        ),
      )
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'Already claimed today', 'ALREADY_CLAIMED_TODAY')
      }
      throw err
    }

    await walletService.adjustCoinBalanceCache(userId, 0n)

    return {
      amount: VIP_DAILY_GRANT_COINS.toString(),
      claimDate: utcDateString(now),
    }
  },

  async processExpiryJob(args: { userId: string }): Promise<void> {
    const u = await prisma.user.findUnique({
      where: { id: args.userId },
      select: { vipSubscriptionExpiresAt: true },
    })
    if (!u?.vipSubscriptionExpiresAt) return
    if (u.vipSubscriptionExpiresAt.getTime() > Date.now()) return

    // Conditional guard: a purchase committed between the read above and this
    // write must not be deactivated (updateMany matches 0 rows in that case).
    await prisma.user.updateMany({
      where: { id: args.userId, vipSubscriptionExpiresAt: { lte: new Date() } },
      data: { vipSubscriptionActive: false },
    })
    await this.refreshCache(args.userId)
    await bustProfileVipCaches(args.userId)
  },

  async getPurchaseHistory(userId: string, opts: { limit: number; cursor?: string | null }) {
    const { items, nextCursor, hasMore } = await vipMembershipRepository.getRecentPurchases(
      userId,
      opts,
    )
    return {
      items: items.map((r) => ({
        id: r.id,
        tier: r.tier,
        periodDays: r.periodDays,
        coinCost: r.coinCost.toString(),
        expiresAtBefore: r.expiresAtBefore?.toISOString() ?? null,
        expiresAtAfter: r.expiresAtAfter.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: nextCursor ?? null,
      hasMore,
    }
  },

  getPublicConfig() {
    return {
      tiers: [
        {
          tier: VipMembershipTier.DIAMOND,
          periodDays: DIAMOND_PERIOD_DAYS,
          coinCost: DIAMOND_COST.toString(),
        },
        {
          tier: VipMembershipTier.SVIP,
          periodDays: SVIP_PERIOD_DAYS,
          coinCost: SVIP_COST.toString(),
        },
      ],
      dailyGrantCoins: VIP_DAILY_GRANT_COINS.toString(),
      durationCapDays: VIP_DURATION_CAP_DAYS,
    }
  },
}
