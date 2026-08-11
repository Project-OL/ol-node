import { CoinTxType, type Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { redisClient, RedisKeys, RICH_CONFIG_TTL, RICH_STATE_TTL } from '../config/redis'
import { richTierRepository } from '../repositories/richTier.repository'
import { vipAssignmentRepository } from '../repositories/vip-assignment.repository'
import { enqueueRolloverMaster } from '../queues/rich-tier.queue'
import { utcMonthBoundsExclusive, utcNow, utcYearMonth } from '../utils/datetime'
import { AppError } from '../middlewares/errorHandler'

/**
 * Personal-COIN credits that count as a "recharge" for Rich tier monthly progress.
 * These represent coins entering a user's personal wallet from an external source.
 * NOTE: Recharge flows do NOT increase wealth level (wealth tracks coin SPEND only).
 * `TRADING_TRANSFER_IN` and `ADJUSTMENT` only count when landing in personal COIN —
 * callers gate `applyRecharge` accordingly.
 */
export const RECHARGE_TX_TYPES = new Set<CoinTxType>([
  CoinTxType.TOPUP,
  CoinTxType.TRADING_TRANSFER_IN,
  CoinTxType.ADJUSTMENT,
])

/** Minimum coins to reach Rich tier N (N = 1..10). Must match `rich_tier_configs` seed. */
export const RICH_TIER_THRESHOLDS: readonly bigint[] = [
  3_000_000n,
  5_000_000n,
  10_000_000n,
  20_000_000n,
  30_000_000n,
  50_000_000n,
  100_000_000n,
  200_000_000n,
  500_000_000n,
  1_000_000_000n,
] as const

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

export function thresholdForTier(tier: number): bigint {
  if (tier < 1 || tier > 10) return 0n
  return RICH_TIER_THRESHOLDS[tier - 1]!
}

/** Highest Rich tier (0..10) for monotonic recharge progress. */
export function computeTier(coinsBigInt: bigint): number {
  let tier = 0
  for (let i = 0; i < RICH_TIER_THRESHOLDS.length; i++) {
    if (coinsBigInt >= RICH_TIER_THRESHOLDS[i]!) {
      tier = i + 1
    } else {
      break
    }
  }
  return tier
}

/** Carryover coins applied at UTC month rollover toward the *next* month’s progress. */
export function applyRetentionRule(newTier: number): bigint {
  if (newTier <= 2) return 0n
  if (newTier <= 6) return thresholdForTier(newTier - 2) / 2n
  if (newTier <= 9) return thresholdForTier(newTier - 3) / 2n
  if (newTier === 10) return thresholdForTier(7) / 2n
  return 0n
}

export type RichTierSnapshotDto = {
  /** Rich level 0–10 (alias of `tier` for profile UIs). */
  level: number
  tier: number
  displayName: string | null
  evaluatedFromYear: number
  evaluatedFromMonth: number
  /** Progress coins this UTC month (carryover + recharge); alias of `currentMonthProgressCoins`. */
  amount: string
  currentMonthRechargeCoins: string
  currentMonthCarryoverCoins: string
  currentMonthProgressCoins: string
  nextTierThreshold: string | null
  nextTierLackingCoins: string | null
  badgeVisible: boolean
}

type RichStateCached = Omit<RichTierSnapshotDto, 'badgeVisible' | 'level' | 'amount'>

async function isUserVipActive(userId: string): Promise<boolean> {
  const lastVip = await vipAssignmentRepository.findMostRecent(userId)
  const now = new Date()
  return lastVip != null && lastVip.isActive && lastVip.revokedAt == null && lastVip.expiresAt > now
}

async function loadConfigMap(): Promise<Map<number, string>> {
  const redis = redisClient
  const key = RedisKeys.richConfig()
  try {
    const cached = await redis.get(key)
    if (cached) {
      const parsed = JSON.parse(cached) as { tier: number; displayName: string }[]
      return new Map(parsed.map((r) => [r.tier, r.displayName]))
    }
  } catch {
    /* cold path */
  }
  const rows = await richTierRepository.getConfig()
  const map = new Map(rows.map((r) => [r.tier, r.displayName]))
  try {
    await redisClient.set(
      key,
      JSON.stringify(rows.map((r) => ({ tier: r.tier, displayName: r.displayName }))),
      'EX',
      RICH_CONFIG_TTL,
    )
  } catch {
    /* ignore */
  }
  return map
}

async function getMonthRechargeCoinsCached(
  userId: string,
  year: number,
  month: number,
): Promise<bigint> {
  const key = RedisKeys.richProgress(userId, year, month)
  try {
    const hit = await redisClient.get(key)
    if (hit != null) return BigInt(hit)
  } catch {
    /* cold */
  }
  const row = await richTierRepository.getMonthlyAggregate(userId, year, month)
  const total = row?.totalRechargeCoins ?? 0n
  try {
    const { endExclusive } = utcMonthBoundsExclusive(year, month)
    const ttl = Math.max(1, Math.ceil((endExclusive.getTime() - Date.now()) / 1000))
    await redisClient.set(key, total.toString(), 'EX', ttl)
  } catch {
    /* ignore */
  }
  return total
}

function buildSnapshotCore(params: {
  /** Persisted badge tier from `user_rich_tier.currentTier` (live on recharge; rollover may correct down). */
  badgeTier: number
  displayMap: Map<number, string>
  evaluatedFromYear: number
  evaluatedFromMonth: number
  currentMonthRechargeCoins: bigint
  currentMonthCarryoverCoins: bigint
  currentMonthProgressCoins: bigint
}): RichStateCached {
  const displayName =
    params.badgeTier > 0 ? (params.displayMap.get(params.badgeTier) ?? null) : null
  const progressTier = computeTier(params.currentMonthProgressCoins)
  const nextTh = progressTier < 10 ? thresholdForTier(progressTier + 1) : null
  const lacking =
    nextTh != null
      ? nextTh > params.currentMonthProgressCoins
        ? nextTh - params.currentMonthProgressCoins
        : 0n
      : null
  return {
    tier: params.badgeTier,
    displayName,
    evaluatedFromYear: params.evaluatedFromYear,
    evaluatedFromMonth: params.evaluatedFromMonth,
    currentMonthRechargeCoins: params.currentMonthRechargeCoins.toString(),
    currentMonthCarryoverCoins: params.currentMonthCarryoverCoins.toString(),
    currentMonthProgressCoins: params.currentMonthProgressCoins.toString(),
    nextTierThreshold: nextTh?.toString() ?? null,
    nextTierLackingCoins: lacking?.toString() ?? null,
  }
}

export const richTierService = {
  async applyRecharge(
    userId: string,
    amountCoins: bigint,
    tx: Prisma.TransactionClient,
  ): Promise<{ year: number; month: number }> {
    const { year, month } = utcYearMonth(utcNow())
    await richTierRepository.upsertMonthlyAggregate(
      { userId, year, month, deltaCoins: amountCoins },
      tx,
    )

    const { rankingService } = await import('./ranking.service')
    await rankingService.onRecharge({ userId, coins: amountCoins }, tx)

    const agg = await richTierRepository.getMonthlyAggregateInTx(userId, year, month, tx)
    const monthTotal = agg?.totalRechargeCoins ?? amountCoins

    const richTierRow = await tx.userRichTier.findUnique({
      where: { userId },
      select: { currentTier: true, carryoverCoins: true },
    })
    const carryover = richTierRow?.carryoverCoins ?? 0n
    const previousTier = richTierRow?.currentTier ?? 0
    const liveProgress = carryover + monthTotal
    const liveTier = computeTier(liveProgress)

    if (liveTier !== previousTier) {
      await tx.userRichTier.upsert({
        where: { userId },
        create: {
          userId,
          currentTier: liveTier,
          carryoverCoins: carryover,
          evaluatedFromYear: year,
          evaluatedFromMonth: month,
        },
        update: {
          currentTier: liveTier,
        },
      })
    }

    return { year, month }
  },

  async refreshCacheAfterRecharge(userId: string, year: number, month: number): Promise<void> {
    try {
      await redisClient.del(RedisKeys.richState(userId))
      await redisClient.del(RedisKeys.richProgress(userId, year, month))
    } catch {
      /* ignore */
    }
  },

  // Follow-up (product): `opts.isVip` / wallet legacy flag may trend false; consider keying badge off paid VIP membership instead.
  async getCurrentTierForUser(
    userId: string,
    opts?: { isVip?: boolean },
  ): Promise<RichTierSnapshotDto> {
    const isVip = opts?.isVip ?? (await isUserVipActive(userId))
    const stateKey = RedisKeys.richState(userId)
    try {
      const cached = await redisClient.get(stateKey)
      if (cached) {
        const parsed = JSON.parse(cached) as RichStateCached
        return {
          ...parsed,
          level: parsed.tier,
          amount: parsed.currentMonthProgressCoins,
          badgeVisible: isVip && parsed.tier > 0,
        }
      }
    } catch {
      /* cold */
    }

    const [row, displayMap, ym] = await Promise.all([
      richTierRepository.getUserRichTier(userId),
      loadConfigMap(),
      Promise.resolve(utcYearMonth(utcNow())),
    ])
    const carry = row?.carryoverCoins ?? 0n
    const monthTotal = await getMonthRechargeCoinsCached(userId, ym.year, ym.month)
    const progress = carry + monthTotal
    const badgeTier = row?.currentTier ?? 0
    const core = buildSnapshotCore({
      badgeTier,
      displayMap,
      evaluatedFromYear: row?.evaluatedFromYear ?? 0,
      evaluatedFromMonth: row?.evaluatedFromMonth ?? 0,
      currentMonthRechargeCoins: monthTotal,
      currentMonthCarryoverCoins: carry,
      currentMonthProgressCoins: progress,
    })

    try {
      await redisClient.set(stateKey, JSON.stringify(core), 'EX', RICH_STATE_TTL)
    } catch {
      /* ignore */
    }

    return {
      ...core,
      level: core.tier,
      amount: core.currentMonthProgressCoins,
      badgeVisible: isVip && badgeTier > 0,
    }
  },

  async processMonthlyRolloverForUser(
    userId: string,
    prevYear: number,
    prevMonth: number,
  ): Promise<void> {
    await prisma.$transaction(
      async (tx) => {
        if (await richTierRepository.historyExists(userId, prevYear, prevMonth, tx)) {
          return
        }
        const prevRow = await tx.userRichTier.findUnique({
          where: { userId },
        })
        const carryIn = prevRow?.carryoverCoins ?? 0n
        const aggRow = await tx.monthlyRechargeAggregate.findUnique({
          where: {
            userId_year_month: {
              userId,
              year: prevYear,
              month: prevMonth,
            },
          },
        })
        const pure = aggRow?.totalRechargeCoins ?? 0n
        const progressTotal = carryIn + pure
        const effectiveTier = computeTier(progressTotal)
        const newCarryover = applyRetentionRule(effectiveTier)
        const rolledAt = new Date()
        await richTierRepository.upsertUserRichTier(
          {
            userId,
            currentTier: effectiveTier,
            evaluatedFromYear: prevYear,
            evaluatedFromMonth: prevMonth,
            evaluatedRechargeCoins: progressTotal,
            carryoverCoins: newCarryover,
            lastRolledOverAt: rolledAt,
          },
          tx,
        )
        await richTierRepository.insertHistory(
          {
            userId,
            year: prevYear,
            month: prevMonth,
            tier: effectiveTier,
            totalProgressCoins: progressTotal,
            carryoverApplied: newCarryover,
            pureRechargeCoins: pure,
          },
          tx,
        )
      },
      {
        isolationLevel: 'Serializable',
        timeout: INTERACTIVE_TX_TIMEOUT_MS,
      },
    )
    try {
      await redisClient.del(RedisKeys.richState(userId))
      await redisClient.del(RedisKeys.richProgress(userId, prevYear, prevMonth))
    } catch {
      /* ignore */
    }
  },

  async enqueueMonthlyRolloverMaster(year: number, month: number, force?: boolean): Promise<void> {
    await enqueueRolloverMaster(year, month, force)
  },

  async getHistory(
    userId: string,
    opts: { limit: number; cursor: string | null },
  ): Promise<{
    items: Array<{
      year: number
      month: number
      tier: number
      totalProgressCoins: string
      carryoverApplied: string
      pureRechargeCoins: string
      createdAt: string
    }>
    nextCursor: string | null
  }> {
    const limit = Math.min(Math.max(opts.limit, 1), 100)
    let before: { year: number; month: number } | null = null
    if (opts.cursor) {
      const parts = opts.cursor.split(':')
      if (parts.length !== 2) {
        throw new AppError(400, 'Invalid cursor', 'INVALID_CURSOR')
      }
      const y = Number(parts[0])
      const m = Number(parts[1])
      if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
        throw new AppError(400, 'Invalid cursor', 'INVALID_CURSOR')
      }
      before = { year: y, month: m }
    }
    const rows = await richTierRepository.listHistory(userId, limit + 1, before)
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last != null ? `${last.year}:${last.month}` : null
    return {
      items: page.map((r) => ({
        year: r.year,
        month: r.month,
        tier: r.tier,
        totalProgressCoins: r.totalProgressCoins.toString(),
        carryoverApplied: r.carryoverApplied.toString(),
        pureRechargeCoins: r.pureRechargeCoins.toString(),
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor,
    }
  },

  async getTierConfig(): Promise<
    Array<{ tier: number; minRechargeCoins: string; displayName: string }>
  > {
    const rows = await richTierRepository.getConfig()
    return rows.map((r) => ({
      tier: r.tier,
      minRechargeCoins: r.minRechargeCoins.toString(),
      displayName: r.displayName,
    }))
  },

  async refreshConfigCache(): Promise<void> {
    try {
      await redisClient.del(RedisKeys.richConfig())
    } catch {
      /* ignore */
    }
  },

  /** Profile card / search: tier + progress amount with VIP-gated badge. */
  getRichTierCardFields: async (
    userId: string,
  ): Promise<{
    level: number
    tier: number
    displayName: string | null
    badgeVisible: boolean
    amount: string
    currentMonthRechargeCoins: string
    currentMonthCarryoverCoins: string
    currentMonthProgressCoins: string
    nextTierThreshold: string | null
    nextTierLackingCoins: string | null
  }> => {
    const snap = await richTierService.getCurrentTierForUser(userId)
    return {
      level: snap.level,
      tier: snap.tier,
      displayName: snap.displayName,
      badgeVisible: snap.badgeVisible,
      amount: snap.amount,
      currentMonthRechargeCoins: snap.currentMonthRechargeCoins,
      currentMonthCarryoverCoins: snap.currentMonthCarryoverCoins,
      currentMonthProgressCoins: snap.currentMonthProgressCoins,
      nextTierThreshold: snap.nextTierThreshold,
      nextTierLackingCoins: snap.nextTierLackingCoins,
    }
  },
}
