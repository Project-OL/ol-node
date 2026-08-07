import { randomUUID } from 'crypto'
import { PointTxType, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  redisClient,
  RedisKeys,
  AGENCY_COMMISSION_ME_CACHE_TTL,
  AGENCY_LEVEL_CONFIG_CACHE_TTL,
  AGENCY_RATE_CACHE_TTL,
} from '../config/redis'
import { bustAgencyDashboardCaches } from './agencyDashboard.service'
import { agencyCommissionRepository } from '../repositories/agencyCommission.repository'
import { agencyPointTransferRepository } from '../repositories/agencyPointTransfer.repository'
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

export const agencyCommissionService = {
  /**
   * Hot path: host point credit â€” same Serializable tx as host ledger insert.
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
    const agencyUserId = host?.currentAgencyId ?? null
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

    if (commissionPoints > 0n) {
      const hostEntry = await tx.pointLedgerEntry.findUnique({
        where: { id: params.hostLedgerEntryId },
        select: { refId: true, metadata: true },
      })
      const { resolvePointLedgerRefId } = await import('../utils/point-transaction-amounts')
      const businessRefId =
        resolvePointLedgerRefId(hostEntry?.refId, hostEntry?.metadata) ?? params.hostLedgerEntryId

      await pointWalletService.creditInTransaction(
        agencyUserId,
        commissionPoints,
        PointTxType.AGENT_COMMISSION,
        tx,
        {
          idempotencyKey: commissionKey,
          refId: businessRefId,
          counterpartyId: params.hostUserId,
          metadata: {
            category: cat,
            rateBp,
            hostTxType: params.hostTxType,
            hostLedgerEntryId: params.hostLedgerEntryId,
          },
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
      nextLevel: snap.nextLevel,
      nextLevelRequirementPoints: snap.lackingPointsToNextLevel,
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
   * Match agency commission tier to rolling-window **agency commission earned**
   * (`host_commission_points` sum). Host earnings are excluded from tier math.
   */
  async recomputeAgencyLevel(
    agencyUserId: string,
    opts?: { skipDailyDedupe?: boolean },
  ): Promise<void> {
    const now = utcNow()
    const { fromDay, toDay } = await agencyCommissionConfigService.resolveRollingWindowDays(now)

    if (!opts?.skipDailyDedupe) {
      const cur = await prismaRead.agency.findUnique({
        where: { userId: agencyUserId },
        select: { lastLevelRecomputedAt: true },
      })
      if (
        cur?.lastLevelRecomputedAt &&
        utcDateString(cur.lastLevelRecomputedAt) === utcDateString(now)
      ) {
        return
      }
    }

    const total = await agencyCommissionRepository.getAgencyWindowTotal(
      agencyUserId,
      fromDay,
      toDay,
      { preferPrimary: true },
    )
    const levels = await agencyCommissionRepository.getLevelConfig()
    let newLevel = 'D'
    for (let i = levels.length - 1; i >= 0; i--) {
      const row = levels[i]!
      if (total >= row.minWindowPoints) {
        newLevel = row.level
        break
      }
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.agency.update({
          where: { userId: agencyUserId },
          data: {
            currentLevel: newLevel,
            currentWindowTotalPoints: total,
            lastLevelRecomputedAt: now,
          },
        })
      },
      {
        isolationLevel: 'Serializable',
        timeout: INTERACTIVE_TX_TIMEOUT_MS,
      },
    )

    await this.bustAgentCommissionCaches(agencyUserId)
  },

  /**
   * Post-commit after applyCommission (or reverse): refresh window total + tier.
   * Uses primary DB; skips same-day dedupe so live credits always update.
   * Commission for the credit that just landed already used the pre-update tier.
   */
  async afterCommissionCreditCommit(agencyUserId: string | null | undefined): Promise<void> {
    if (!agencyUserId) return
    await this.recomputeAgencyLevel(agencyUserId, { skipDailyDedupe: true })
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
    currentLiveRateBp: number
    currentMatchChatRateBp: number
    nextLevel: string | null
    nextLevelMinWindowPoints: string | null
    lackingPointsToNextLevel: string | null
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

    const period = resolveCommissionPeriod(periodParams)
    const { from, toExclusive } = commissionPeriodToLedgerBounds(period.start, period.end)
    const ag = await prismaRead.agency.findUnique({
      where: { userId: agencyUserId },
    })
    if (!ag) {
      throw new AppError(404, 'Agency not found', 'NOT_FOUND')
    }
    const cfg = await agencyCommissionRepository.getLevelRow(ag.currentLevel)
    const levels = await agencyCommissionRepository.getLevelConfig()
    const idx = levels.findIndex((l) => l.level === ag.currentLevel)
    const nextRow = idx >= 0 && idx + 1 < levels.length ? levels[idx + 1]! : null

    const { fromDay, toDay } = await agencyCommissionConfigService.resolveRollingWindowDays()
    const windowTotal = await agencyCommissionRepository.getAgencyWindowTotal(
      agencyUserId,
      fromDay,
      toDay,
    )

    const [agg, liveDurationSeconds, dailyEarnings] = await Promise.all([
      agencyCommissionRepository.aggregateLedgerByTxTypeForAgencyHosts({
        agencyUserId,
        from,
        toExclusive,
      }),
      agencyCommissionRepository.sumLiveDurationForAgency(agencyUserId, period.start, period.end),
      agencyCommissionRepository.sumAgencyDailyEarnings(agencyUserId, period.start, period.end),
    ])

    let lacking: bigint | null = null
    if (nextRow) {
      const gap = nextRow.minWindowPoints - windowTotal
      lacking = gap > 0n ? gap : 0n
    }

    const snap = {
      currentLevel: ag.currentLevel,
      currentWindowTotalPoints: windowTotal.toString(),
      currentLiveRateBp: cfg?.liveRateBp ?? 400,
      currentMatchChatRateBp: cfg?.matchChatRateBp ?? 400,
      nextLevel: nextRow?.level ?? null,
      nextLevelMinWindowPoints: nextRow?.minWindowPoints.toString() ?? null,
      lackingPointsToNextLevel: lacking?.toString() ?? null,
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
      await redisClient.set(key, JSON.stringify(snap), 'EX', AGENCY_COMMISSION_ME_CACHE_TTL)
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
    const [rows, liveDurationSeconds, dailyEarnings] = await Promise.all([
      agencyCommissionRepository.aggregateLedgerForSingleHost({
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
    ])
    const map = Object.fromEntries(rows.map((r) => [r.txType, r.totalAmount])) as Record<
      string,
      bigint
    >

    let liveEarnings = 0n
    for (const t of LIVE_COMMISSION_TX_TYPES) {
      liveEarnings += map[t] ?? 0n
    }
    const privateChat = map.VIDEO_CALL ?? 0n
    const subscription = map.SUBSCRIPTION ?? 0n
    const platformRewards = map.PLATFORM_REWARD ?? 0n

    let other = 0n
    for (const pt of COMMISSION_ELIGIBLE_TX_TYPES) {
      if (!LIVE_COMMISSION_TX_TYPES.has(pt) && !MATCH_CHAT_COMMISSION_TX_TYPES.has(pt)) {
        other += map[pt] ?? 0n
      }
    }

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
      totals: {
        allCredits: Object.values(map)
          .reduce((a, b) => a + b, 0n)
          .toString(),
        liveEarnings: liveEarnings.toString(),
        privateChat: privateChat.toString(),
        subscription: subscription.toString(),
        platformRewards: platformRewards.toString(),
        otherEarnings: other.toString(),
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
