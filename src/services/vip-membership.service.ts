import { CoinTxType, LevelType, VipMembershipTier } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  RedisKeys,
  VIPM_ACTIVE_INACTIVE_TTL,
  VIPM_ACTIVE_TTL_MAX,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { cacheService } from './cache.service'
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
  SVIP_COST,
  SVIP_PERIOD_DAYS,
  VIP_DAILY_GRANT_COINS,
  VIP_DURATION_CAP_DAYS,
} from './vip-membership.helpers'
import { syncLevelCacheFromApplyResult, type LevelApplyResult } from './user-level.service'

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

async function writeMembershipCache(args: {
  userId: string
  isActive: boolean
  expiresAt: Date | null
  tier: VipMembershipTier | null
}): Promise<void> {
  const key = cacheKey(args.userId)
  if (!args.isActive || !args.expiresAt || args.expiresAt.getTime() <= Date.now() || !args.tier) {
    await cacheService.set(key, 'null', VIPM_ACTIVE_INACTIVE_TTL)
    return
  }
  const ttlSec = Math.min(
    VIPM_ACTIVE_TTL_MAX,
    Math.max(1, Math.floor((args.expiresAt.getTime() - Date.now()) / 1000)),
  )
  await cacheService.set(
    key,
    JSON.stringify({
      tier: args.tier,
      expiresAt: args.expiresAt.toISOString(),
    }),
    ttlSec,
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
    const tier = state.isActive ? await vipMembershipRepository.getLatestTier(userId) : null
    await writeMembershipCache({
      userId,
      isActive: state.isActive,
      expiresAt: state.expiresAt,
      tier,
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
    const tier = state.isActive ? await vipMembershipRepository.getLatestTier(userId) : null
    await writeMembershipCache({
      userId,
      isActive: state.isActive,
      expiresAt: state.expiresAt,
      tier,
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
      const tierRows =
        activeIds.length > 0
          ? await prismaRead.vipMembershipPurchase.findMany({
              where: { userId: { in: activeIds } },
              orderBy: { createdAt: 'desc' },
              select: { userId: true, tier: true },
            })
          : []
      const tierByUser = new Map<string, VipMembershipTier>()
      for (const r of tierRows) {
        if (!tierByUser.has(r.userId)) tierByUser.set(r.userId, r.tier)
      }

      const pipe = redisClient.pipeline()
      for (const id of misses) {
        const st = dbMap.get(id)!
        const tier = st.isActive ? (tierByUser.get(id) ?? null) : null
        out.set(id, st.isActive)
        if (!st.isActive || !st.expiresAt || !tier || st.expiresAt.getTime() <= Date.now()) {
          pipe.set(cacheKey(id), 'null', 'EX', VIPM_ACTIVE_INACTIVE_TTL)
        } else {
          const ttlSec = Math.min(
            VIPM_ACTIVE_TTL_MAX,
            Math.max(1, Math.floor((st.expiresAt.getTime() - Date.now()) / 1000)),
          )
          pipe.set(
            cacheKey(id),
            JSON.stringify({
              tier,
              expiresAt: st.expiresAt.toISOString(),
            }),
            'EX',
            ttlSec,
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
    const tier = state.isActive
      ? ((await vipMembershipRepository.getLatestTier(userId)) ?? undefined)
      : undefined
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
    const tier = (await vipMembershipRepository.getLatestTier(userId)) ?? undefined
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
    const tierRows =
      activeIdList.length > 0
        ? await prismaRead.vipMembershipPurchase.findMany({
            where: { userId: { in: activeIdList } },
            orderBy: { createdAt: 'desc' },
            select: { userId: true, tier: true },
          })
        : []
    const tierByUser = new Map<string, VipMembershipTier>()
    for (const r of tierRows) {
      if (!tierByUser.has(r.userId)) tierByUser.set(r.userId, r.tier)
    }
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
    const { proposedExpiresAt } = await prisma.$transaction(
      async (tx) => {
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
      {
        isolationLevel: 'Serializable',
        timeout: INTERACTIVE_TX_TIMEOUT_MS,
      },
    )

    await walletService.adjustCoinBalanceCache(userId, coinCost)
    await syncLevelCacheFromApplyResult(userId, LevelType.WEALTH, buyerWealthResult)
    await this.refreshCache(userId)
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

    await prisma.$transaction(
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
      {
        isolationLevel: 'Serializable',
        timeout: INTERACTIVE_TX_TIMEOUT_MS,
      },
    )

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

    await prisma.user.update({
      where: { id: args.userId },
      data: { vipSubscriptionActive: false },
    })
    await this.refreshCache(args.userId)
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
