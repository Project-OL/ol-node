import crypto from 'crypto'
import type { Guardian, GuardianTier } from '@prisma/client'
import { PointTxType, LevelType } from '@prisma/client'
import { prisma } from '../config/database'
import { HOST_REVENUE_SHARES, hostPointsFromGuardian } from '../config/host-revenue-shares'
import { AppError } from '../middlewares/errorHandler'
import { redisClient, RedisKeys, GUARDIAN_ACTIVE_TTL, GUARDIAN_LIST_TTL } from '../config/redis'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'
import { cacheService } from './cache.service'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { userRepository } from '../repositories/user.repository'
import {
  guardianRepository,
  type GuardianUserCard,
  type GuardianWithGuardianUser,
  type GuardianWithTargetUser,
} from '../repositories/guardian.repository'
import { enqueueGuardianExpiry } from '../queues/guardian.queue'
import { ledgerHostPointsKey } from '../utils/ledger-idempotency'
import type { PurchaseGuardianInput } from '../models/guardian.schemas'
import type { ActiveGuardianProfileDto } from '../models/profile.types'
import {
  walletLevelService,
  syncLevelCacheFromApplyResult,
  type LevelApplyResult,
} from './user-level.service'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

const MONTHLY_PRICE: Record<GuardianTier, number> = {
  SILVER: 150_000,
  GOLD: 300_000,
  KING: 1_500_000,
}

const DURATION_MULTIPLIER: Record<number, number> = {
  1: 1,
  3: 3,
  6: 6,
  12: 12,
}

const TIER_RANK: Record<GuardianTier, number> = {
  SILVER: 1,
  GOLD: 2,
  KING: 3,
}

function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime())
  const expected = d.getDate()
  d.setMonth(d.getMonth() + months)
  if (d.getDate() !== expected) {
    d.setDate(0)
  }
  return d
}

function sortGuardiansForRank<T extends { tier: GuardianTier; expiresAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const tr = TIER_RANK[b.tier] - TIER_RANK[a.tier]
    if (tr !== 0) return tr
    return b.expiresAt.getTime() - a.expiresAt.getTime()
  })
}

export function pickTopGuardian(rows: Guardian[]): Guardian | null {
  if (rows.length === 0) return null
  return sortGuardiansForRank(rows)[0] ?? null
}

function computeAge(dob: Date | null): number | null {
  if (!dob) return null
  const today = new Date()
  let age = today.getFullYear() - dob.getFullYear()
  const m = today.getMonth() - dob.getMonth()
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    age--
  }
  return age >= 0 ? age : null
}

export type GuardianConfigDuration = { months: number; totalCoins: number }
export type GuardianConfigTier = {
  tier: GuardianTier
  monthlyPrice: number
  durations: GuardianConfigDuration[]
}
export type GuardianConfig = { tiers: GuardianConfigTier[] }

export type GuardianListUser = {
  id: string
  username: string
  displayName: string
  name: string
  avatarUrl: string | null
  publicId: string
  displayPublicId: string
  country: string | null
  gender: string | null
  age: number | null
  livestreamLevel: number
  wealthLevel: number
}

export type GuardianListItem = {
  guardianId: string
  tier: GuardianTier
  durationMonths: number
  expiresAt: string
  daysRemaining: number
  user: GuardianListUser
  isTopGuardian: boolean
}

export type ActiveGuardianResponse = {
  tier: GuardianTier
  guardianUserId: string
  guardianUsername: string
  daysRemaining: number
  expiresAt: string
}

export type ActiveGuardianSummary = ActiveGuardianProfileDto

type CachedActiveGuardianSummary = {
  guardianId: string
  guardianUserId: string
  guardianPublicId: string
  displayPublicId: string
  displayName: string
  avatarUrl: string | null
  tier: string
  purchasedAt: string
  expiresAt: string
} | null

function parseCachedActiveGuardianSummary(raw: string): ActiveGuardianSummary | null {
  try {
    const parsed = JSON.parse(raw) as CachedActiveGuardianSummary
    if (!parsed) return null
    if (
      typeof parsed.guardianId !== 'string' ||
      typeof parsed.guardianUserId !== 'string' ||
      typeof parsed.guardianPublicId !== 'string' ||
      typeof parsed.displayName !== 'string' ||
      (parsed.avatarUrl !== null && typeof parsed.avatarUrl !== 'string') ||
      typeof parsed.tier !== 'string' ||
      typeof parsed.purchasedAt !== 'string' ||
      typeof parsed.expiresAt !== 'string'
    ) {
      return null
    }
    const purchasedAt = new Date(parsed.purchasedAt)
    const expiresAt = new Date(parsed.expiresAt)
    if (Number.isNaN(purchasedAt.getTime()) || Number.isNaN(expiresAt.getTime())) {
      return null
    }
    return {
      guardianId: parsed.guardianId,
      guardianUserId: parsed.guardianUserId,
      guardianPublicId: parsed.guardianPublicId,
      displayPublicId: parsed.displayPublicId ?? parsed.guardianPublicId,
      displayName: parsed.displayName,
      avatarUrl: parsed.avatarUrl,
      tier: parsed.tier,
      purchasedAt,
      expiresAt,
      user: {
        userId: parsed.guardianUserId,
        publicId: parsed.guardianPublicId,
        displayPublicId: parsed.displayPublicId ?? parsed.guardianPublicId,
        name: parsed.displayName,
        avatarUrl: parsed.avatarUrl,
      },
    }
  } catch {
    return null
  }
}

function daysRemainingFor(expiresAt: Date): number {
  return Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000))
}

function computeTopGuardianIdsByTarget(rows: Guardian[]): Map<string, string | null> {
  const byTarget = new Map<string, Guardian[]>()
  for (const r of rows) {
    const list = byTarget.get(r.targetUserId) ?? []
    list.push(r)
    byTarget.set(r.targetUserId, list)
  }
  const out = new Map<string, string | null>()
  for (const [tid, list] of byTarget) {
    out.set(tid, pickTopGuardian(list)?.id ?? null)
  }
  return out
}

async function invalidatePurchaseCaches(args: {
  targetUserId: string
  guardianUserIds: string[]
}): Promise<void> {
  await Promise.all([
    cacheService.delete(RedisKeys.guardianActive(args.targetUserId)),
    cacheService.delete(RedisKeys.guardianMeList(args.targetUserId)),
    ...args.guardianUserIds.map((id) => cacheService.delete(RedisKeys.guardianMyList(id))),
  ])
}

async function rankTopFromDb(targetUserId: string): Promise<Guardian | null> {
  const rows = await guardianRepository.findActiveGuardiansForTarget(targetUserId)
  return pickTopGuardian(rows)
}

function mapToListItem(
  row: Guardian,
  related: GuardianUserCard,
  targetUserIdForTop: string,
  topByTarget: Map<string, string | null>,
  levels: Map<string, { livestreamLevel: number; wealthLevel: number }>,
): GuardianListItem {
  const topId = topByTarget.get(targetUserIdForTop) ?? null
  const level = levels.get(related.id)
  const displayName = buildUserDisplayName(related)
  return {
    guardianId: row.id,
    tier: row.tier,
    durationMonths: row.durationMonths,
    expiresAt: row.expiresAt.toISOString(),
    daysRemaining: daysRemainingFor(row.expiresAt),
    user: {
      id: related.id,
      username: related.username,
      displayName,
      name: displayName,
      avatarUrl: related.avatarUrl,
      publicId: related.publicId.toString(),
      displayPublicId: resolveDisplayPublicId(related),
      country: related.country,
      gender: related.gender,
      age: computeAge(related.dateOfBirth),
      livestreamLevel: level?.livestreamLevel ?? 0,
      wealthLevel: level?.wealthLevel ?? 0,
    },
    isTopGuardian: row.id === topId,
  }
}

function guardianListCacheHasUserEnrichment(items: GuardianListItem[]): boolean {
  const u = items[0]?.user
  return (
    u != null &&
    typeof u === 'object' &&
    'publicId' in u &&
    'displayPublicId' in u &&
    'name' in u &&
    'livestreamLevel' in u &&
    'wealthLevel' in u
  )
}

type GuardianPurchaseResult = {
  guardianId: string
  tier: GuardianTier
  durationMonths: number
  coinsPaid: string
  expiresAt: Date
  daysRemaining: number
}

export const guardianService = {
  getGuardianConfig(): GuardianConfig {
    const tiers = (Object.keys(MONTHLY_PRICE) as GuardianTier[]).map((tier) => ({
      tier,
      monthlyPrice: MONTHLY_PRICE[tier],
      durations: ([1, 3, 6, 12] as const).map((months) => ({
        months,
        totalCoins: MONTHLY_PRICE[tier] * DURATION_MULTIPLIER[months],
      })),
    }))
    return { tiers }
  },

  async purchaseGuardian(
    guardianUserId: string,
    input: PurchaseGuardianInput,
  ): Promise<{
    guardianId: string
    tier: GuardianTier
    durationMonths: number
    coinsPaid: string
    expiresAt: Date
    daysRemaining: number
  }> {
    if (!input.idempotencyKey) {
      // Legacy path: per-request ledger key, no replay window.
      return this.executePurchaseGuardian(
        guardianUserId,
        input,
        `guardian-purchase:${crypto.randomUUID()}`,
      )
    }

    // Same envelope as gifts/send: Redis replay + SET NX in-flight marker;
    // ledger keys derive from the client key so the DB unique constraint
    // backstops after the TTL. expiresAt must be revived (route calls
    // .toISOString() on it).
    const idem = `guardian-purchase:${guardianUserId}:${input.idempotencyKey}`
    const cached = (await walletService.getCachedIdemResponse(idem)) as
      | (Omit<GuardianPurchaseResult, 'expiresAt'> & { expiresAt: string })
      | null
    if (cached) return { ...cached, expiresAt: new Date(cached.expiresAt) }

    const acquired = await walletService.acquireIdemKey(idem)
    if (!acquired) {
      throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')
    }

    let result: GuardianPurchaseResult
    try {
      result = await this.executePurchaseGuardian(
        guardianUserId,
        input,
        `guardian-purchase:${guardianUserId}:${input.idempotencyKey}`,
        { guardDuplicateKey: true },
      )
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'Duplicate guardian purchase (already processed)', 'IDEM_CONFLICT')
      }
      try {
        await redisClient.del(RedisKeys.walletIdem(idem))
      } catch {
        // best-effort
      }
      throw err
    }
    try {
      await walletService.resolveIdemKey(idem, result)
    } catch {
      // Replay window lost; ledger unique keys still prevent double-processing.
    }
    return result
  },

  async executePurchaseGuardian(
    guardianUserId: string,
    input: PurchaseGuardianInput,
    idempotencyKey: string,
    opts?: { guardDuplicateKey?: boolean },
  ): Promise<{
    guardianId: string
    tier: GuardianTier
    durationMonths: number
    coinsPaid: string
    expiresAt: Date
    daysRemaining: number
  }> {
    if (guardianUserId === input.targetUserId) {
      throw new AppError(400, 'Cannot guardian yourself', 'CANNOT_GUARDIAN_SELF')
    }
    const target = await userRepository.findById(input.targetUserId)
    if (!target) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const mult = DURATION_MULTIPLIER[input.durationMonths]
    if (mult === undefined) {
      throw new AppError(400, 'Invalid duration', 'INVALID_DURATION')
    }
    const totalCoins = BigInt(MONTHLY_PRICE[input.tier] * mult)
    const expiresAt = addMonths(new Date(), input.durationMonths)

    let bustAgentUserId: string | null = null
    let buyerWealthResult: LevelApplyResult | null = null
    let hostLivestreamResult: LevelApplyResult | null = null
    // Read Committed: buyer COIN wallet + target/agent POINT wallets are locked
    // FOR UPDATE inside the debit/credit helpers; guardians upsert and
    // commission increments are atomic. Serializable previously aborted
    // concurrent purchasers with 40001 500s. The duplicate-key guard below
    // prevents a post-Redis-window retry from re-extending the guardian
    // (the ledger debit would otherwise replay silently and re-run the upsert
    // with a fresh expiry).
    const guardian = await withSerializationRetry(() =>
      prisma.$transaction(async (tx) => {
        // Client-keyed calls only: a post-Redis-window retry must not let the
        // debit replay silently and re-run the guardians upsert with a fresh
        // expiry. Random legacy keys cannot collide, so they skip the query.
        if (opts?.guardDuplicateKey) {
          const dup = await coinLedgerRepository.findByIdempotencyKey(tx, idempotencyKey)
          if (dup) {
            throw new AppError(
              409,
              'Duplicate guardian purchase (already processed)',
              'IDEM_CONFLICT',
            )
          }
        }
        buyerWealthResult = await coinWalletService.debitForGuardianPurchase(
          guardianUserId,
          totalCoins,
          {
            targetUserId: input.targetUserId,
            idempotencyKey,
            applyWealthXp: true,
          },
          tx,
        )
        const row = await guardianRepository.upsertGuardian(
          {
            guardianUserId,
            targetUserId: input.targetUserId,
            tier: input.tier,
            durationMonths: input.durationMonths,
            coinsPaid: totalCoins,
            expiresAt,
          },
          tx,
        )

        const hostPoints = hostPointsFromGuardian(totalCoins)
        if (hostPoints > 0n) {
          const credited = await pointWalletService.creditInTransaction(
            input.targetUserId,
            hostPoints,
            PointTxType.GUARDIAN_PURCHASE,
            tx,
            {
              idempotencyKey: ledgerHostPointsKey(idempotencyKey),
              refId: row.id,
              counterpartyId: guardianUserId,
              description: 'Guardian purchase revenue (75%)',
              metadata: {
                coinsPaid: totalCoins.toString(),
                tier: input.tier,
                hostShareBp: HOST_REVENUE_SHARES.GUARDIAN_PURCHASE_BP,
              },
              applyLivestreamLevel: true,
            },
          )
          bustAgentUserId = credited.bustAgentUserId
          hostLivestreamResult = credited.livestreamLevelResult
        }

        return row
      }),
    )

    await walletService.adjustCoinBalanceCache(guardianUserId, totalCoins)
    await syncLevelCacheFromApplyResult(guardianUserId, LevelType.WEALTH, buyerWealthResult)
    await syncLevelCacheFromApplyResult(
      input.targetUserId,
      LevelType.LIVESTREAM,
      hostLivestreamResult,
    )
    const hostPoints = hostPointsFromGuardian(totalCoins)
    if (hostPoints > 0n) {
      await walletService.adjustPointBalanceCache(input.targetUserId, hostPoints)
    }
    if (bustAgentUserId) {
      const { agencyCommissionService } = await import('./agencyCommission.service')
      await agencyCommissionService.afterCommissionCreditCommit(bustAgentUserId)
    }
    await enqueueGuardianExpiry(guardian.id, expiresAt)

    const activeRows = await guardianRepository.findActiveGuardiansForTarget(input.targetUserId)
    const guardianUserIds = [...new Set(activeRows.map((g) => g.guardianUserId))]
    await invalidatePurchaseCaches({
      targetUserId: input.targetUserId,
      guardianUserIds,
    })

    return {
      guardianId: guardian.id,
      tier: guardian.tier,
      durationMonths: guardian.durationMonths,
      coinsPaid: guardian.coinsPaid.toString(),
      expiresAt: guardian.expiresAt,
      daysRemaining: daysRemainingFor(guardian.expiresAt),
    }
  },

  /**
   * Invalidate active cache and return the new top guardian from DB (worker + post-expiry).
   */
  async recalculateActiveGuardian(targetUserId: string): Promise<Guardian | null> {
    const top = await rankTopFromDb(targetUserId)
    await cacheService.delete(RedisKeys.guardianActive(targetUserId))
    return top
  },

  async toActiveGuardianResponse(top: Guardian): Promise<ActiveGuardianResponse> {
    const guardianUser = await userRepository.findById(top.guardianUserId)
    if (!guardianUser) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }
    return {
      tier: top.tier,
      guardianUserId: top.guardianUserId,
      guardianUsername: guardianUser.username,
      daysRemaining: daysRemainingFor(top.expiresAt),
      expiresAt: top.expiresAt.toISOString(),
    }
  },

  async getActiveGuardianSummary(targetUserId: string): Promise<ActiveGuardianSummary | null> {
    const key = RedisKeys.guardianActive(targetUserId)
    const cached = await cacheService.get(key)
    if (cached !== null) {
      const parsed = parseCachedActiveGuardianSummary(cached)
      if (parsed !== null || cached === 'null') {
        return parsed
      }
    }

    const top = await rankTopFromDb(targetUserId)
    if (!top) {
      await cacheService.set(key, 'null', GUARDIAN_ACTIVE_TTL)
      return null
    }

    const guardianUser = await userRepository.findById(top.guardianUserId)
    if (!guardianUser) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    const displayName = buildUserDisplayName(guardianUser)
    const displayPublicId = resolveDisplayPublicId(guardianUser)

    const summary: ActiveGuardianSummary = {
      guardianId: top.id,
      guardianUserId: top.guardianUserId,
      guardianPublicId: guardianUser.publicId.toString(),
      displayPublicId,
      displayName,
      avatarUrl: guardianUser.avatarUrl,
      tier: top.tier,
      purchasedAt: top.purchasedAt,
      expiresAt: top.expiresAt,
      user: {
        userId: top.guardianUserId,
        publicId: guardianUser.publicId.toString(),
        displayPublicId,
        name: displayName,
        avatarUrl: guardianUser.avatarUrl,
      },
    }

    await cacheService.set(
      key,
      JSON.stringify({
        ...summary,
        purchasedAt: summary.purchasedAt.toISOString(),
        expiresAt: summary.expiresAt.toISOString(),
      }),
      GUARDIAN_ACTIVE_TTL,
    )
    return summary
  },

  /**
   * Batched getActiveGuardianSummary for list endpoints: one Redis pipeline for
   * cached summaries, one guardians query + one users query for misses. Uses the
   * same per-target cache keys/JSON format ('null' sentinel included) as the
   * single-target path, so invalidation behavior is unchanged.
   */
  async getActiveGuardianSummariesBulk(
    targetUserIds: string[],
  ): Promise<Map<string, ActiveGuardianSummary | null>> {
    const unique = [...new Set(targetUserIds.filter(Boolean))]
    const out = new Map<string, ActiveGuardianSummary | null>()
    if (unique.length === 0) return out

    let cached: (string | null)[] = new Array(unique.length).fill(null)
    try {
      const pipe = redisClient.pipeline()
      for (const id of unique) pipe.get(RedisKeys.guardianActive(id))
      const exec = await pipe.exec()
      if (exec && exec.length === unique.length) {
        cached = exec.map(([, v]) => v as string | null)
      }
    } catch {
      // Redis unavailable — treat all as misses
    }

    const missing: string[] = []
    for (let i = 0; i < unique.length; i++) {
      const id = unique[i]!
      const raw = cached[i]
      if (raw !== null && raw !== undefined) {
        const parsed = parseCachedActiveGuardianSummary(raw)
        if (parsed !== null || raw === 'null') {
          out.set(id, parsed)
          continue
        }
      }
      missing.push(id)
    }
    if (missing.length === 0) return out

    const activeRows = await guardianRepository.findActiveByTargetIds(missing)
    const rowsByTarget = new Map<string, Guardian[]>()
    for (const row of activeRows) {
      const list = rowsByTarget.get(row.targetUserId)
      if (list) list.push(row)
      else rowsByTarget.set(row.targetUserId, [row])
    }

    const topByTarget = new Map<string, Guardian>()
    for (const id of missing) {
      const top = pickTopGuardian(rowsByTarget.get(id) ?? [])
      if (top) topByTarget.set(id, top)
    }

    const guardianUserIds = [...new Set([...topByTarget.values()].map((g) => g.guardianUserId))]
    const guardianUsers = await userRepository.findDisplayRowsByIds(guardianUserIds)
    const usersById = new Map(guardianUsers.map((u) => [u.id, u]))

    const writePipe = redisClient.pipeline()
    for (const id of missing) {
      const top = topByTarget.get(id)
      if (!top) {
        out.set(id, null)
        writePipe.set(RedisKeys.guardianActive(id), 'null', 'EX', GUARDIAN_ACTIVE_TTL)
        continue
      }
      const guardianUser = usersById.get(top.guardianUserId)
      if (!guardianUser) {
        // Same failure mode as the single-target path.
        throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
      }
      const displayName = buildUserDisplayName(guardianUser)
      const displayPublicId = resolveDisplayPublicId(guardianUser)
      const summary: ActiveGuardianSummary = {
        guardianId: top.id,
        guardianUserId: top.guardianUserId,
        guardianPublicId: guardianUser.publicId.toString(),
        displayPublicId,
        displayName,
        avatarUrl: guardianUser.avatarUrl,
        tier: top.tier,
        purchasedAt: top.purchasedAt,
        expiresAt: top.expiresAt,
        user: {
          userId: top.guardianUserId,
          publicId: guardianUser.publicId.toString(),
          displayPublicId,
          name: displayName,
          avatarUrl: guardianUser.avatarUrl,
        },
      }
      out.set(id, summary)
      writePipe.set(
        RedisKeys.guardianActive(id),
        JSON.stringify({
          ...summary,
          purchasedAt: summary.purchasedAt.toISOString(),
          expiresAt: summary.expiresAt.toISOString(),
        }),
        'EX',
        GUARDIAN_ACTIVE_TTL,
      )
    }
    try {
      await writePipe.exec()
    } catch {
      // best-effort cache write
    }
    return out
  },

  async getActiveGuardian(targetUserId: string): Promise<ActiveGuardianResponse | null> {
    const summary = await this.getActiveGuardianSummary(targetUserId)
    if (!summary) return null

    const guardianUser = await userRepository.findById(summary.guardianUserId)
    if (!guardianUser) {
      throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    }

    return {
      tier: summary.tier as GuardianTier,
      guardianUserId: summary.guardianUserId,
      guardianUsername: guardianUser.username,
      daysRemaining: daysRemainingFor(summary.expiresAt),
      expiresAt: summary.expiresAt.toISOString(),
    }
  },

  async getMyGuardians(userId: string): Promise<GuardianListItem[]> {
    const key = RedisKeys.guardianMyList(userId)
    const hit = await cacheService.get(key)
    if (hit) {
      try {
        const parsed = JSON.parse(hit) as GuardianListItem[]
        if (parsed.length === 0) return parsed
        if (guardianListCacheHasUserEnrichment(parsed)) return parsed
        await cacheService.delete(key)
      } catch {
        /* miss */
      }
    }
    const rows = await guardianRepository.findMyGuardians(userId)
    const targetIds = [...new Set(rows.map((r) => r.targetUserId))]
    const tops = computeTopGuardianIdsByTarget(
      await guardianRepository.findActiveByTargetIds(targetIds),
    )
    const relatedUserIds = [...new Set(rows.map((r) => r.targetUser.id))]
    const levels = await walletLevelService.getDisplayLevelsForUsers(relatedUserIds)
    const items = rows.map((r: GuardianWithTargetUser) =>
      mapToListItem(r, r.targetUser, r.targetUserId, tops, levels),
    )
    await cacheService.set(key, JSON.stringify(items), GUARDIAN_LIST_TTL)
    return items
  },

  async getGuardiansOfMe(userId: string): Promise<GuardianListItem[]> {
    const key = RedisKeys.guardianMeList(userId)
    const hit = await cacheService.get(key)
    if (hit) {
      try {
        const parsed = JSON.parse(hit) as GuardianListItem[]
        if (parsed.length === 0) return parsed
        if (guardianListCacheHasUserEnrichment(parsed)) return parsed
        await cacheService.delete(key)
      } catch {
        /* miss */
      }
    }
    const rows = await guardianRepository.findGuardiansOfMe(userId)
    const tops = computeTopGuardianIdsByTarget(
      await guardianRepository.findActiveByTargetIds([userId]),
    )
    const relatedUserIds = [...new Set(rows.map((r) => r.guardianUser.id))]
    const levels = await walletLevelService.getDisplayLevelsForUsers(relatedUserIds)
    const items = rows.map((r: GuardianWithGuardianUser) =>
      mapToListItem(r, r.guardianUser, userId, tops, levels),
    )
    await cacheService.set(key, JSON.stringify(items), GUARDIAN_LIST_TTL)
    return items
  },

  async processExpiryJob(guardianId: string): Promise<void> {
    const g = await guardianRepository.findById(guardianId)
    if (!g || g.isExpired) return
    if (g.expiresAt.getTime() > Date.now()) return
    await guardianRepository.markExpired(guardianId)
    await guardianService.recalculateActiveGuardian(g.targetUserId)
    await Promise.all([
      cacheService.delete(RedisKeys.guardianActive(g.targetUserId)),
      cacheService.delete(RedisKeys.guardianMeList(g.targetUserId)),
      cacheService.delete(RedisKeys.guardianMyList(g.guardianUserId)),
    ])
  },
}
