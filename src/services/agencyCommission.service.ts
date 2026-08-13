import { randomUUID } from 'crypto'
import { PointTxType, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { rootLogger } from '../utils/rootLogger'
import {
  redisClient,
  RedisKeys,
  AGENCY_COMMISSION_ME_CACHE_TTL,
  AGENCY_LEVEL_CONFIG_CACHE_TTL,
  AGENCY_RATE_CACHE_TTL,
} from '../config/redis'
import { bustAgencyDashboardCaches, readAgencyEarningsCacheEpoch } from './agencyDashboard.service'
import { agencyCommissionRepository } from '../repositories/agencyCommission.repository'
import { agencyPointTransferRepository } from '../repositories/agencyPointTransfer.repository'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { pointWalletService } from './point-wallet.service'
import { cacheRedisService } from './cacheRedis.service'
import { AppError } from '../middlewares/errorHandler'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'
import {
  assertPositiveAmountMultiple,
  AGENT_POINT_TRANSFER_STEP,
} from '../utils/transaction-amount-steps'
import {
  commissionPeriodToLedgerBounds,
  resolveCommissionPeriod,
  utcDateString,
  utcNow,
} from '../utils/datetime'
import { enqueueAgencyRecomputeMaster as publishAgencyRecomputeMasterJob } from '../queues/agency-commission.queue'
import { walletService } from './wallet.service'
import { agencyCommissionConfigService } from './agencyCommissionConfig.service'
import { env } from '../config/env'
import {
  computeTierLockBonus,
  effectiveTierWindowTotal,
  lockUntilFromNow,
  matchAgencyLevel,
  serializeAgencyTierLock,
} from '../utils/agency-tier-lock'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000
export const MIN_AGENT_POINT_TRANSFER = AGENT_POINT_TRANSFER_STEP

/**
 * Point tx types that trigger agency commission.
 * ONLY gifts and video calls generate commission.
 * Subscription and guardian host credits do NOT.
 */
export const LIVE_COMMISSION_TX_TYPES = new Set<PointTxType>([
  PointTxType.GIFT_RECEIVE,
  PointTxType.LIVESTREAM_GIFT, // legacy enum, eligible if ever written
])

export const MATCH_CHAT_COMMISSION_TX_TYPES = new Set<PointTxType>([PointTxType.VIDEO_CALL])

export const COMMISSION_ELIGIBLE_TX_TYPES = new Set<PointTxType>([
  ...LIVE_COMMISSION_TX_TYPES,
  ...MATCH_CHAT_COMMISSION_TX_TYPES,
])

export type CommissionCategory = 'LIVE' | 'MATCH_CHAT'

export type CommissionPeriodParams = {
  periodDays?: number
  from?: string
  to?: string
}

function formatDuration(seconds: bigint): string {
  const s = Number(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function commissionCacheKey(params: CommissionPeriodParams): string {
  if (params.from && params.to) return `${params.from}_${params.to}`
  return String(params.periodDays ?? 30)
}

function categoryForTx(txType: PointTxType): CommissionCategory | null {
  if (LIVE_COMMISSION_TX_TYPES.has(txType)) return 'LIVE'
  if (MATCH_CHAT_COMMISSION_TX_TYPES.has(txType)) return 'MATCH_CHAT'
  return null
}

/** Gift fields copied onto AGENT_COMMISSION metadata from the host GIFT_RECEIVE ledger row. */
export type GiftCommissionMetadata = {
  giftId: string
  giftName?: string
  context?: string
  quantity?: number
  unitCoinCost?: number
  senderUserId?: string
}

/**
 * Extract gift sender + gift details from the host earning ledger entry.
 * Returns null when the host row is not a gift credit (no giftId in metadata).
 */
export function giftFieldsFromHostLedger(
  hostEntry: {
    counterpartyId: string | null
    metadata: unknown
  } | null,
): GiftCommissionMetadata | null {
  if (!hostEntry) return null
  const meta =
    hostEntry.metadata && typeof hostEntry.metadata === 'object' && !Array.isArray(hostEntry.metadata)
      ? (hostEntry.metadata as Record<string, unknown>)
      : null
  if (!meta || typeof meta.giftId !== 'string' || meta.giftId.length === 0) {
    return null
  }
  const out: GiftCommissionMetadata = { giftId: meta.giftId }
  if (typeof meta.giftName === 'string' && meta.giftName.length > 0) {
    out.giftName = meta.giftName
  }
  if (typeof meta.context === 'string') {
    out.context = meta.context
  }
  if (typeof meta.quantity === 'number' && Number.isFinite(meta.quantity)) {
    out.quantity = meta.quantity
  }
  if (typeof meta.unitCoinCost === 'number' && Number.isFinite(meta.unitCoinCost)) {
    out.unitCoinCost = meta.unitCoinCost
  }
  if (hostEntry.counterpartyId) {
    out.senderUserId = hostEntry.counterpartyId
  }
  return out
}

export type AgencyTierWindowMetric = {
  total: bigint
  from: Date
  toExclusive: Date
  fromDay: Date
  toDay: Date
  totalMinutes: number
  includeHostEarnings: boolean
  includeAgencyCommission: boolean
}

/**
 * Build a note describing which env-gated sources feed the tier window total.
 */
export function agencyTierWindowMetricNote(metric: {
  includeHostEarnings: boolean
  includeAgencyCommission: boolean
}): string {
  const parts: string[] = []
  if (metric.includeHostEarnings) {
    parts.push(
      'host earnings = SUM(agency_daily_earnings.host_earnings_points) on overlapping UTC calendar days [from, to]',
    )
  }
  if (metric.includeAgencyCommission) {
    parts.push(
      'agency commission = unreversed AGENT_COMMISSION credits in half-open [fromAt, toExclusiveAt)',
    )
  }
  return parts.join('; ')
}

function resolveAgencyUserIdForHost(
  currentAgencyId: string | null | undefined,
  ownedAgencyUserId: string | null | undefined,
): string | null {
  return currentAgencyId ?? ownedAgencyUserId ?? null
}

export const agencyCommissionService = {
  /**
   * Hot path: host point credit — same Serializable tx as host ledger insert.
   */
  async applyCommission(
    params: {
      hostUserId: string
      hostLedgerEntryId: string
      hostPointsCredited: bigint
      hostTxType: PointTxType
      day: Date
    },
    tx: Prisma.TransactionClient,
  ): Promise<{ bustAgentUserId: string | null }> {
    const host = await tx.user.findUnique({
      where: { id: params.hostUserId },
      select: { currentAgencyId: true },
    })
    // Prefer join membership; agency owners are also hosts of their own agency even when
    // `currentAgencyId` was never set at approve-time.
    let agencyUserId = host?.currentAgencyId ?? null
    if (!agencyUserId) {
      const owned = await tx.agency.findUnique({
        where: { userId: params.hostUserId },
        select: { userId: true },
      })
      agencyUserId = resolveAgencyUserIdForHost(null, owned?.userId)
    }
    if (!agencyUserId) {
      return { bustAgentUserId: null }
    }

    if (!COMMISSION_ELIGIBLE_TX_TYPES.has(params.hostTxType)) {
      return { bustAgentUserId: null }
    }

    const commissionKey = `agency-commission:${params.hostLedgerEntryId}`

    const agencyRow = await tx.agency.findUnique({
      where: { userId: agencyUserId },
      select: { currentLevel: true, pausedAt: true, pausedUntil: true },
    })
    const nowMs = Date.now()
    const agencyPaused =
      agencyRow?.pausedAt != null &&
      (agencyRow.pausedUntil == null || agencyRow.pausedUntil.getTime() > nowMs)
    if (agencyPaused) {
      // Mark processed so retries do not re-attempt; no commission while suspended.
      try {
        await tx.agencyCommissionProcessed.create({
          data: { hostLedgerEntryId: params.hostLedgerEntryId },
        })
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return { bustAgentUserId: null }
        }
        throw e
      }
      return { bustAgentUserId: null }
    }

    const levelKey = agencyRow?.currentLevel ?? 'D'
    const levelCfg = await tx.agencyCommissionLevel.findUnique({
      where: { level: levelKey },
    })
    if (!levelCfg) {
      throw new AppError(500, 'Missing agency commission level row', 'CONFIG_ERROR')
    }

    const cat = categoryForTx(params.hostTxType)
    if (!cat) {
      return { bustAgentUserId: null }
    }
    const rateBp = cat === 'LIVE' ? levelCfg.liveRateBp : levelCfg.matchChatRateBp

    const commissionPoints = (params.hostPointsCredited * BigInt(rateBp)) / 10_000n

    try {
      await tx.agencyCommissionProcessed.create({
        data: { hostLedgerEntryId: params.hostLedgerEntryId },
      })
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return { bustAgentUserId: null }
      }
      throw e
    }

    await agencyCommissionRepository.upsertDailyEarning(
      {
        agencyUserId,
        hostUserId: params.hostUserId,
        day: params.day,
        hostEarningsDelta: params.hostPointsCredited,
        hostCommissionDelta: commissionPoints,
      },
      tx,
    )

    const { rankingService } = await import('./ranking.service')
    await rankingService.onAgencyEarnings(
      {
        agencyUserId,
        hostEarningsDelta: params.hostPointsCredited,
        day: params.day,
      },
      tx,
    )

    if (commissionPoints > 0n) {
      const hostEntry = await tx.pointLedgerEntry.findUnique({
        where: { id: params.hostLedgerEntryId },
        select: { refId: true, metadata: true, counterpartyId: true },
      })
      const { resolvePointLedgerRefId } = await import('../utils/point-transaction-amounts')
      const businessRefId =
        resolvePointLedgerRefId(hostEntry?.refId, hostEntry?.metadata) ?? params.hostLedgerEntryId

      const giftFields = giftFieldsFromHostLedger(hostEntry)
      const metadata: Prisma.JsonObject = {
        category: cat,
        rateBp,
        hostTxType: params.hostTxType,
        hostLedgerEntryId: params.hostLedgerEntryId,
        ...(giftFields ?? {}),
      }

      await pointWalletService.creditInTransaction(
        agencyUserId,
        commissionPoints,
        PointTxType.AGENT_COMMISSION,
        tx,
        {
          idempotencyKey: commissionKey,
          refId: businessRefId,
          counterpartyId: params.hostUserId,
          description: giftFields?.giftName
            ? `Agency commission: ${giftFields.giftName}`
            : undefined,
          metadata,
          applyLivestreamLevel: false,
        },
      )
    }

    return { bustAgentUserId: agencyUserId }
  },

  /**
   * Undo `applyCommission` for a host point credit (admin gift/point revert).
   * Debits the agent’s AGENT_COMMISSION credit (fails if agent lacks points),
   * reverses daily earning deltas (floored at 0), and clears the processed marker.
   */
  async reverseCommission(
    params: {
      hostLedgerEntryId: string
      reason: string
    },
    tx: Prisma.TransactionClient,
  ): Promise<{
    bustAgentUserId: string | null
    reversed: boolean
    commissionPoints: string | null
  }> {
    const processed = await tx.agencyCommissionProcessed.findUnique({
      where: { hostLedgerEntryId: params.hostLedgerEntryId },
    })
    if (!processed) {
      return { bustAgentUserId: null, reversed: false, commissionPoints: null }
    }

    const hostEntry = await tx.pointLedgerEntry.findUnique({
      where: { id: params.hostLedgerEntryId },
      select: {
        id: true,
        amount: true,
        createdAt: true,
        txType: true,
        wallet: { select: { userId: true } },
      },
    })
    if (!hostEntry) {
      return { bustAgentUserId: null, reversed: false, commissionPoints: null }
    }

    const hostUserId = hostEntry.wallet.userId
    const commissionKey = `agency-commission:${params.hostLedgerEntryId}`
    const reverseKey = `agency-commission-reverse:${params.hostLedgerEntryId}`

    const commissionEntry = await tx.pointLedgerEntry.findUnique({
      where: { idempotencyKey: commissionKey },
      include: { wallet: { select: { userId: true } } },
    })

    let agencyUserId: string | null = null
    let commissionPoints = 0n

    if (commissionEntry) {
      agencyUserId = commissionEntry.wallet.userId
      commissionPoints = commissionEntry.amount
      await pointWalletService.debit(agencyUserId, commissionPoints, PointTxType.ADJUSTMENT, tx, {
        idempotencyKey: reverseKey,
        description: `Admin commission reverse: ${params.reason}`.slice(0, 500),
        counterpartyId: hostUserId,
        refId: params.hostLedgerEntryId,
        availabilityCheck: true,
        metadata: {
          source: 'admin_commission_reverse',
          hostLedgerEntryId: params.hostLedgerEntryId,
          originalCommissionLedgerEntryId: commissionEntry.id,
          reason: params.reason,
        },
      })
    } else {
      const host = await tx.user.findUnique({
        where: { id: hostUserId },
        select: { currentAgencyId: true },
      })
      agencyUserId = host?.currentAgencyId ?? null
      if (!agencyUserId) {
        const owned = await tx.agency.findUnique({
          where: { userId: hostUserId },
          select: { userId: true },
        })
        agencyUserId = resolveAgencyUserIdForHost(null, owned?.userId)
      }
    }

    if (agencyUserId) {
      const { utcDayFromTimestamp } = await import('../utils/datetime')
      await agencyCommissionRepository.upsertDailyEarning(
        {
          agencyUserId,
          hostUserId,
          day: utcDayFromTimestamp(hostEntry.createdAt),
          hostEarningsDelta: -hostEntry.amount,
          hostCommissionDelta: -commissionPoints,
        },
        tx,
      )

      const { rankingService } = await import('./ranking.service')
      await rankingService.onAgencyEarnings(
        {
          agencyUserId,
          hostEarningsDelta: -hostEntry.amount,
          day: utcDayFromTimestamp(hostEntry.createdAt),
        },
        tx,
      )
    }

    {
      const { utcDayFromTimestamp } = await import('../utils/datetime')
      const { rankingService } = await import('./ranking.service')
      await rankingService.onHostPointCredit(
        {
          hostUserId,
          amount: -hostEntry.amount,
          txType: hostEntry.txType,
          day: utcDayFromTimestamp(hostEntry.createdAt),
        },
        tx,
      )
    }

    await tx.agencyCommissionProcessed.delete({
      where: { hostLedgerEntryId: params.hostLedgerEntryId },
    })

    return {
      bustAgentUserId: agencyUserId,
      reversed: true,
      commissionPoints: commissionPoints > 0n ? commissionPoints.toString() : null,
    }
  },

  async bustAgentCommissionCaches(agencyUserId: string): Promise<void> {
    try {
      await Promise.all([
        redisClient.del(RedisKeys.agencyRate(agencyUserId)),
        cacheRedisService.del(RedisKeys.agencyMe(agencyUserId)),
        cacheRedisService.delByKeyPrefix(RedisKeys.agencyCommissionMe(agencyUserId)),
        cacheRedisService.delByKeyPrefix(`agency:host:breakdown:${agencyUserId}`),
        // Also bumps agencyEarningsCacheEpoch + deletes dashboard today/earnings/hosts.
        bustAgencyDashboardCaches(agencyUserId),
      ])
    } catch {
      /* ignore */
    }
  },

  async buildMeAgentCommissionSummary(agentUserId: string) {
    const snap = await this.getCommissionMeSnapshot(agentUserId, { periodDays: 30 })
    return {
      currentLevel: snap.currentLevel,
      currentLiveRatePercent: snap.currentLiveRateBp / 100,
      currentMatchChatRatePercent: snap.currentMatchChatRateBp / 100,
      currentWindowTotalPoints: snap.currentWindowTotalPoints,
      effectiveWindowTotalPoints: snap.effectiveWindowTotalPoints,
      nextLevel: snap.nextLevel,
      nextLevelRequirementPoints: snap.lackingPointsToNextLevel,
      tierLockLevel: snap.tierLockLevel,
      tierLockUntil: snap.tierLockUntil,
      tierLockBonusPoints: snap.tierLockBonusPoints,
    }
  },

  async getLevelConfig(): Promise<
    Array<{
      level: string
      minWindowPoints: string
      liveRateBp: number
      matchChatRateBp: number
      sortOrder: number
    }>
  > {
    const key = RedisKeys.agencyLevelConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        return JSON.parse(hit) as Array<{
          level: string
          minWindowPoints: string
          liveRateBp: number
          matchChatRateBp: number
          sortOrder: number
        }>
      }
    } catch {
      /* cold */
    }
    const rows = await agencyCommissionRepository.getLevelConfig()
    const dto = rows.map((r) => ({
      level: r.level,
      minWindowPoints: r.minWindowPoints.toString(),
      liveRateBp: r.liveRateBp,
      matchChatRateBp: r.matchChatRateBp,
      sortOrder: r.sortOrder,
    }))
    try {
      await redisClient.set(key, JSON.stringify(dto), 'EX', AGENCY_LEVEL_CONFIG_CACHE_TTL)
    } catch {
      /* ignore */
    }
    return dto
  },

  async getRateForAgent(
    agencyUserId: string,
    category: CommissionCategory,
  ): Promise<{ level: string; rateBp: number }> {
    const key = RedisKeys.agencyRate(agencyUserId)
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as {
          level: string
          liveRateBp: number
          matchChatRateBp: number
        }
        return {
          level: parsed.level,
          rateBp: category === 'LIVE' ? parsed.liveRateBp : parsed.matchChatRateBp,
        }
      }
    } catch {
      /* cold */
    }

    const agencyRow = await prismaRead.agency.findUnique({
      where: { userId: agencyUserId },
      select: { currentLevel: true },
    })
    const levelKey = agencyRow?.currentLevel ?? 'D'
    const cfg = await agencyCommissionRepository.getLevelRow(levelKey)
    if (!cfg) {
      throw new AppError(500, 'Missing agency commission level row', 'CONFIG_ERROR')
    }
    const payload = {
      level: cfg.level,
      liveRateBp: cfg.liveRateBp,
      matchChatRateBp: cfg.matchChatRateBp,
    }
    try {
      await redisClient.set(key, JSON.stringify(payload), 'EX', AGENCY_RATE_CACHE_TTL)
    } catch {
      /* ignore */
    }
    return {
      level: cfg.level,
      rateBp: category === 'LIVE' ? cfg.liveRateBp : cfg.matchChatRateBp,
    }
  },

  /**
   * Rolling-window total for agency tier matching / progress.
   * Sources gated by env (same for live recompute, nightly job, admin force):
   * - `AGENCY_TIER_INCLUDE_HOST_EARNINGS` (default on): day-bucket host earnings
   * - `AGENCY_TIER_INCLUDE_AGENCY_COMMISSION` (default off): ledger AGENT_COMMISSION
   */
  async resolveTierWindowTotal(
    agencyUserId: string,
    opts?: { preferPrimary?: boolean; now?: Date },
  ): Promise<AgencyTierWindowMetric> {
    const now = opts?.now ?? utcNow()
    const { from, toExclusive, totalMinutes } =
      await agencyCommissionConfigService.resolveRollingWindowBounds(now)
    const { fromDay, toDay } = await agencyCommissionConfigService.resolveRollingWindowDays(now)
    const includeHostEarnings = env.AGENCY_TIER_INCLUDE_HOST_EARNINGS
    const includeAgencyCommission = env.AGENCY_TIER_INCLUDE_AGENCY_COMMISSION

    let total = 0n
    if (includeHostEarnings) {
      const daily = await agencyCommissionRepository.sumAgencyDailyEarnings(
        agencyUserId,
        fromDay,
        toDay,
        { preferPrimary: opts?.preferPrimary },
      )
      total += daily.hostEarningsPoints
    }
    if (includeAgencyCommission) {
      total += await agencyCommissionRepository.sumAgencyCommissionLedgerWindow(
        agencyUserId,
        from,
        toExclusive,
        { preferPrimary: opts?.preferPrimary },
      )
    }

    return {
      total,
      from,
      toExclusive,
      fromDay,
      toDay,
      totalMinutes,
      includeHostEarnings,
      includeAgencyCommission,
    }
  },

  /**
   * Snapshot an admin-assigned tier as a rolling-window floor (signed bonus).
   * Sets `currentLevel` immediately; later recomputes cannot drop below it until `lockUntil`.
   */
  async snapshotAdminTierLock(
    agencyUserId: string,
    level: string,
    opts?: { tx?: Prisma.TransactionClient; now?: Date; actualWindowTotal?: bigint },
  ): Promise<{
    commissionTier: string
    actualWindowTotalPoints: string
    tierLockLevel: string
    tierLockUntil: string
    tierLockBonusPoints: string
  }> {
    const now = opts?.now ?? utcNow()
    const tierRow = await agencyCommissionRepository.getLevelRow(level)
    if (!tierRow) {
      throw new AppError(400, 'Invalid commission tier', 'INVALID_COMMISSION_TIER')
    }
    const actual =
      opts?.actualWindowTotal ??
      (
        await this.resolveTierWindowTotal(agencyUserId, {
          preferPrimary: true,
          now,
        })
      ).total
    const { totalMinutes } = await agencyCommissionConfigService.resolveRollingWindowBounds(now)
    const bonus = computeTierLockBonus(tierRow.minWindowPoints, actual)
    const lockUntil = lockUntilFromNow(now, totalMinutes)
    const client = opts?.tx ?? prisma
    await client.agency.update({
      where: { userId: agencyUserId },
      data: {
        currentLevel: tierRow.level,
        currentWindowTotalPoints: actual,
        lastLevelRecomputedAt: now,
        tierLockLevel: tierRow.level,
        tierLockUntil: lockUntil,
        tierLockBonusPoints: bonus,
      },
    })
    return {
      commissionTier: tierRow.level,
      actualWindowTotalPoints: actual.toString(),
      tierLockLevel: tierRow.level,
      tierLockUntil: lockUntil.toISOString(),
      tierLockBonusPoints: bonus.toString(),
    }
  },

  /**
   * Match agency commission tier to the env-configured rolling-window metric
   * (see {@link resolveTierWindowTotal}). While an admin tier lock is active,
   * matching uses actual + signed bonus with a floor at the assigned tier.
   */
  async recomputeAgencyLevel(
    agencyUserId: string,
    opts?: { skipDailyDedupe?: boolean },
  ): Promise<void> {
    const MAX_CAS_ATTEMPTS = 5

    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      const now = utcNow()

      const cur = await prisma.agency.findUnique({
        where: { userId: agencyUserId },
        select: {
          lastLevelRecomputedAt: true,
          tierLockLevel: true,
          tierLockUntil: true,
          tierLockBonusPoints: true,
        },
      })

      if (!opts?.skipDailyDedupe) {
        if (
          cur?.lastLevelRecomputedAt &&
          utcDateString(cur.lastLevelRecomputedAt) === utcDateString(now)
        ) {
          return
        }
      }

      const { total: actual } = await this.resolveTierWindowTotal(agencyUserId, {
        preferPrimary: true,
        now,
      })
      const levels = await agencyCommissionRepository.getLevelConfig()
      const lockLevelRow = cur?.tierLockLevel
        ? (levels.find((l) => l.level === cur.tierLockLevel) ?? null)
        : null
      const { effective, lockActive } = effectiveTierWindowTotal({
        actual,
        lock: {
          tierLockLevel: cur?.tierLockLevel ?? null,
          tierLockUntil: cur?.tierLockUntil ?? null,
          tierLockBonusPoints: cur?.tierLockBonusPoints ?? null,
        },
        lockLevelMinWindowPoints: lockLevelRow?.minWindowPoints ?? null,
        now,
      })
      const newLevel = matchAgencyLevel(effective, levels)

      // Compare-and-swap on lastLevelRecomputedAt (bumped on every real write,
      // including live-credit calls which pass skipDailyDedupe): if another
      // concurrent recompute committed since we read `cur` above, `count` is 0
      // and we retry from a fresh read instead of overwriting its result with
      // data we computed from now-stale state (lost-update under concurrent
      // commission credits to the same agency).
      const { count } = await prisma.agency.updateMany({
        where: { userId: agencyUserId, lastLevelRecomputedAt: cur?.lastLevelRecomputedAt ?? null },
        data: {
          currentLevel: newLevel,
          currentWindowTotalPoints: actual,
          lastLevelRecomputedAt: now,
          ...(lockActive
            ? {}
            : {
                tierLockLevel: null,
                tierLockUntil: null,
                tierLockBonusPoints: null,
              }),
        },
      })

      if (count === 1) {
        await this.bustAgentCommissionCaches(agencyUserId)
        return
      }
    }

    rootLogger.warn(
      { agencyUserId },
      'recomputeAgencyLevel: exhausted CAS retries, skipping this cycle',
    )
  },

  /**
   * Post-commit after applyCommission (or reverse): refresh window total + tier.
   * Uses primary DB; skips same-day dedupe so live credits always update.
   * Commission for the credit that just landed already used the pre-update tier.
   * Always busts agent commission / dashboard caches even if tier recompute fails,
   * so `/agency/dashboard/*` does not serve a stale 30s Redis snapshot.
   */
  async afterCommissionCreditCommit(agencyUserId: string | null | undefined): Promise<void> {
    if (!agencyUserId) return
    try {
      await this.recomputeAgencyLevel(agencyUserId, { skipDailyDedupe: true })
    } finally {
      // recomputeAgencyLevel also busts on success; keep this for failed recomputes.
      await this.bustAgentCommissionCaches(agencyUserId)
    }
  },

  async enqueueDailyRecomputeMaster(opts?: { utcDate?: string; force?: boolean }): Promise<void> {
    const d = opts?.utcDate ?? utcDateString(utcNow())
    await publishAgencyRecomputeMasterJob(d, opts?.force)
  },

  /** Half-open window `[from, toExclusive)` in UTC for ledger timestamps (rolling window ending today). */
  resolvePeriodBounds(periodDays: number): { from: Date; toExclusive: Date } {
    const { start, end } = resolveCommissionPeriod({ periodDays })
    return commissionPeriodToLedgerBounds(start, end)
  },

  async getCommissionMeSnapshot(
    agencyUserId: string,
    periodParams: CommissionPeriodParams,
  ): Promise<{
    currentLevel: string
    currentWindowTotalPoints: string
    effectiveWindowTotalPoints: string
    currentLiveRateBp: number
    currentMatchChatRateBp: number
    nextLevel: string | null
    nextLevelMinWindowPoints: string | null
    lackingPointsToNextLevel: string | null
    tierLockLevel: string | null
    tierLockUntil: string | null
    tierLockBonusPoints: string | null
    periodDays: number | null
    from: string | null
    to: string | null
    liveDurationSeconds: string
    liveDurationFormatted: string
    totalEarningsPoints: string
    byTxType: Array<{ txType: string; totalAmount: string }>
  }> {
    const periodKey = commissionCacheKey(periodParams)
    const key = RedisKeys.agencyCommissionMe(agencyUserId, periodKey)
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as never
    } catch {
      /* miss */
    }

    const epoch = await readAgencyEarningsCacheEpoch(agencyUserId)
    const period = resolveCommissionPeriod(periodParams)
    const { from, toExclusive } = commissionPeriodToLedgerBounds(period.start, period.end)
    const ag = await prisma.agency.findUnique({
      where: { userId: agencyUserId },
    })
    if (!ag) {
      throw new AppError(404, 'Agency not found', 'NOT_FOUND')
    }
    const cfg = await agencyCommissionRepository.getLevelRow(ag.currentLevel)
    const levels = await agencyCommissionRepository.getLevelConfig()
    const idx = levels.findIndex((l) => l.level === ag.currentLevel)
    const nextRow = idx >= 0 && idx + 1 < levels.length ? levels[idx + 1]! : null

    const windowMetric = await this.resolveTierWindowTotal(agencyUserId, {
      preferPrimary: true,
    })
    const windowTotal = windowMetric.total
    const now = utcNow()
    const lockLevelRow = ag.tierLockLevel
      ? (levels.find((l) => l.level === ag.tierLockLevel) ?? null)
      : null
    const { effective } = effectiveTierWindowTotal({
      actual: windowTotal,
      lock: {
        tierLockLevel: ag.tierLockLevel,
        tierLockUntil: ag.tierLockUntil,
        tierLockBonusPoints: ag.tierLockBonusPoints,
      },
      lockLevelMinWindowPoints: lockLevelRow?.minWindowPoints ?? null,
      now,
    })
    const lockDto = serializeAgencyTierLock(
      {
        tierLockLevel: ag.tierLockLevel,
        tierLockUntil: ag.tierLockUntil,
        tierLockBonusPoints: ag.tierLockBonusPoints,
      },
      now,
    )

    const [agg, liveDurationSeconds, dailyEarnings] = await Promise.all([
      agencyCommissionRepository.aggregateLedgerByTxTypeForAgencyHosts({
        agencyUserId,
        from,
        toExclusive,
        preferPrimary: true,
      }),
      agencyCommissionRepository.sumLiveDurationForAgency(agencyUserId, period.start, period.end),
      agencyCommissionRepository.sumAgencyDailyEarnings(agencyUserId, period.start, period.end, {
        preferPrimary: true,
      }),
    ])

    let lacking: bigint | null = null
    if (nextRow) {
      const gap = nextRow.minWindowPoints - effective
      lacking = gap > 0n ? gap : 0n
    }

    const snap = {
      currentLevel: ag.currentLevel,
      currentWindowTotalPoints: windowTotal.toString(),
      effectiveWindowTotalPoints: effective.toString(),
      currentLiveRateBp: cfg?.liveRateBp ?? 400,
      currentMatchChatRateBp: cfg?.matchChatRateBp ?? 400,
      nextLevel: nextRow?.level ?? null,
      nextLevelMinWindowPoints: nextRow?.minWindowPoints.toString() ?? null,
      lackingPointsToNextLevel: lacking?.toString() ?? null,
      ...lockDto,
      periodDays: periodParams.from && periodParams.to ? null : (periodParams.periodDays ?? 30),
      from: periodParams.from ?? null,
      to: periodParams.to ?? null,
      liveDurationSeconds: liveDurationSeconds.toString(),
      liveDurationFormatted: formatDuration(liveDurationSeconds),
      totalEarningsPoints: (
        dailyEarnings.hostEarningsPoints + dailyEarnings.hostCommissionPoints
      ).toString(),
      byTxType: agg.map((r) => ({
        txType: r.txType,
        totalAmount: r.totalAmount.toString(),
      })),
    }

    try {
      const epochNow = await readAgencyEarningsCacheEpoch(agencyUserId)
      if (epochNow === epoch) {
        await redisClient.set(key, JSON.stringify(snap), 'EX', AGENCY_COMMISSION_ME_CACHE_TTL)
      }
    } catch {
      /* ignore */
    }
    return snap
  },

  async listHostsByEarnings(
    agencyUserId: string,
    periodParams: CommissionPeriodParams,
    opts: { limit: number; offset: number },
  ) {
    const period = resolveCommissionPeriod(periodParams)
    const rows = await agencyCommissionRepository.sumHostEarningsByHost(
      agencyUserId,
      period.start,
      period.end,
      { limit: opts.limit, offset: opts.offset },
    )
    const hasMore = rows.length > opts.limit
    const page = hasMore ? rows.slice(0, opts.limit) : rows
    return {
      items: page.map((r) => ({
        hostUserId: r.hostUserId,
        hostEarningsPoints: r.hostEarningsPoints.toString(),
        hostCommissionPoints: r.hostCommissionPoints.toString(),
        totalEarningsPoints: (r.hostEarningsPoints + r.hostCommissionPoints).toString(),
        liveDurationSeconds: r.liveDurationSeconds.toString(),
        liveDurationFormatted: formatDuration(r.liveDurationSeconds),
      })),
      nextOffset: hasMore ? opts.offset + opts.limit : null,
      periodDays: periodParams.from && periodParams.to ? null : (periodParams.periodDays ?? 30),
      from: periodParams.from ?? null,
      to: periodParams.to ?? null,
    }
  },

  async getHostCommissionDetail(
    agencyUserId: string,
    hostUserId: string,
    periodParams: CommissionPeriodParams,
  ) {
    const membership = await prismaRead.agencyHost.findUnique({
      where: { hostUserId },
      select: { agencyUserId: true },
    })
    if (!membership || membership.agencyUserId !== agencyUserId) {
      throw new AppError(403, 'Host not in your agency', 'FORBIDDEN')
    }

    const period = resolveCommissionPeriod(periodParams)
    const { from, toExclusive } = commissionPeriodToLedgerBounds(period.start, period.end)
    const last3Months = resolveCommissionPeriod({ periodDays: 90 })

    const [
      rows,
      buckets,
      liveDurationSeconds,
      dailyEarnings,
      last3MonthsDaily,
      hostUser,
      remainingPoints,
    ] = await Promise.all([
      agencyCommissionRepository.aggregateLedgerForSingleHost({
        hostUserId,
        agencyUserId,
        from,
        toExclusive,
      }),
      agencyCommissionRepository.aggregateHostEarningsBuckets({
        hostUserId,
        agencyUserId,
        from,
        toExclusive,
      }),
      agencyCommissionRepository.sumLiveDurationForHost(
        agencyUserId,
        hostUserId,
        period.start,
        period.end,
      ),
      agencyCommissionRepository.sumHostDailyEarnings(
        agencyUserId,
        hostUserId,
        period.start,
        period.end,
      ),
      agencyCommissionRepository.sumHostDailyEarnings(
        agencyUserId,
        hostUserId,
        last3Months.start,
        last3Months.end,
      ),
      prismaRead.user.findUnique({
        where: { id: hostUserId },
        select: { hourlyWage: true },
      }),
      walletService.getPointBalance(hostUserId),
    ])

    const map = Object.fromEntries(rows.map((r) => [r.txType, r.totalAmount])) as Record<
      string,
      bigint
    >
    const subscription = map.SUBSCRIPTION ?? 0n

    return {
      hostUserId,
      periodDays: periodParams.from && periodParams.to ? null : (periodParams.periodDays ?? 30),
      from: periodParams.from ?? null,
      to: periodParams.to ?? null,
      liveDurationSeconds: liveDurationSeconds.toString(),
      liveDurationFormatted: formatDuration(liveDurationSeconds),
      totalEarningsPoints: (
        dailyEarnings.hostEarningsPoints + dailyEarnings.hostCommissionPoints
      ).toString(),
      /** Host gross points only (`agency_daily_earnings.host_earnings_points`), rolling 90 UTC days. */
      totalEarningsLast3Months: last3MonthsDaily.hostEarningsPoints.toString(),
      totalEarningsLast3MonthsFrom: utcDateString(last3Months.start),
      totalEarningsLast3MonthsTo: utcDateString(last3Months.end),
      platformHourlySalary: (hostUser?.hourlyWage ?? 0n).toString(),
      rankReward: '0',
      /** Current POINT wallet balance (available / remaining), not period-scoped. */
      remainingPoints: remainingPoints.toString(),
      totals: {
        allCredits: buckets.allCredits.toString(),
        liveEarnings: buckets.liveEarnings.toString(),
        /** Message / DM gifts only (`GIFT_RECEIVE` + metadata.context = direct). */
        privateChat: buckets.privateChat.toString(),
        /** Reserved — tips not implemented yet. */
        tips: '0',
        subscription: subscription.toString(),
        platformRewards: buckets.platformRewards.toString(),
        /** Includes VIDEO_CALL and any other non-gift / non-platform-reward credits. */
        otherEarnings: buckets.otherEarnings.toString(),
      },
      byTxType: rows.map((r) => ({
        txType: r.txType,
        totalAmount: r.totalAmount.toString(),
      })),
    }
  },

  async transferPointsToAgent(params: {
    senderUserId: string
    recipientAgentUserId: string
    points: bigint
    idempotencyKey: string
  }): Promise<{ transferId: string }> {
    const { senderUserId, recipientAgentUserId, points, idempotencyKey } = params

    if (senderUserId === recipientAgentUserId) {
      throw new AppError(400, 'Cannot transfer to yourself', 'INVALID_RECIPIENT')
    }
    assertPositiveAmountMultiple(points, AGENT_POINT_TRANSFER_STEP, {
      belowMinCode: 'MIN_TRANSFER_VIOLATION',
      unitLabel: 'points to transfer',
    })

    const faceIndexed = await faceVerificationRepository.isIndexedForUser(senderUserId)
    if (!faceIndexed) {
      throw new AppError(
        403,
        'Face verification must be completed and indexed before transferring points',
        'FACE_NOT_INDEXED',
      )
    }

    const recipientAg = await prismaRead.agency.findUnique({
      where: { userId: recipientAgentUserId },
    })
    if (!recipientAg) {
      throw new AppError(400, 'Recipient is not an agent', 'INVALID_RECIPIENT')
    }

    const existingBefore = await prismaRead.agentPointTransfer.findUnique({
      where: { idempotencyKey },
    })
    if (existingBefore) {
      return { transferId: existingBefore.id }
    }

    const transferId = randomUUID()

    // Read Committed: both POINT wallets are FOR UPDATE-locked inside
    // debit/creditInTransaction; the transfer row's unique idempotency key is
    // the replay anchor. Serializable previously aborted parallel duplicates
    // with 40001/P2002 500s (and the old in-tx duplicate branch returned a
    // transferId that did not exist).
    const runTransferTransaction = () =>
      prisma.$transaction(
        async (tx) => {
          const existing = await tx.agentPointTransfer.findUnique({
            where: { idempotencyKey },
          })
          if (existing) {
            return existing.id
          }

          const debit = await pointWalletService.debit(
            senderUserId,
            points,
            PointTxType.AGENT_POINT_TRANSFER,
            tx,
            {
              idempotencyKey: `${idempotencyKey}:debit`,
              counterpartyId: recipientAgentUserId,
              refId: transferId,
              metadata: { transferId },
            },
          )

          const credit = await pointWalletService.creditInTransaction(
            recipientAgentUserId,
            points,
            PointTxType.AGENT_POINT_TRANSFER,
            tx,
            {
              idempotencyKey: `${idempotencyKey}:credit`,
              counterpartyId: senderUserId,
              refId: transferId,
              metadata: { transferId },
              applyLivestreamLevel: false,
            },
          )

          await agencyPointTransferRepository.insertTransfer(
            {
              id: transferId,
              senderAgentUserId: senderUserId,
              recipientAgentUserId,
              points,
              senderLedgerEntryId: debit.ledgerEntryId,
              recipientLedgerEntryId: credit.ledgerEntryId,
              idempotencyKey,
            },
            tx,
          )
          return transferId
        },
        { timeout: INTERACTIVE_TX_TIMEOUT_MS },
      )

    let settledTransferId: string
    try {
      settledTransferId = await withSerializationRetry(runTransferTransaction)
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Parallel duplicate key: winner committed between the existence check
        // and our insert â€” re-run once; the check now returns the original row.
        settledTransferId = await runTransferTransaction()
      } else {
        throw err
      }
    }

    await Promise.all([
      walletService.adjustPointBalanceCache(senderUserId, -points),
      walletService.adjustPointBalanceCache(recipientAgentUserId, points),
    ])

    return { transferId: settledTransferId }
  },
}
