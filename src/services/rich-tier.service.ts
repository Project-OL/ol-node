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

/** Minimum coins to reach Rich tier N (N = 1..10). Seed / fallback when `rich_tier_configs` is empty. */
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

export const RICH_TIER_DISPLAY_NAMES: readonly string[] = [
  'RICH I',
  'RICH II',
  'RICH III',
  'RICH IV',
  'RICH V',
  'RICH VI',
  'RICH VII',
  'RICH VIII',
  'RICH IX',
  'RICH X',
] as const

export type RichTierLadderRow = {
  tier: number
  minRechargeCoins: bigint
  displayName: string
}

export function defaultRichTierLadder(): RichTierLadderRow[] {
  return RICH_TIER_THRESHOLDS.map((minRechargeCoins, i) => ({
    tier: i + 1,
    minRechargeCoins,
    displayName: RICH_TIER_DISPLAY_NAMES[i]!,
  }))
}

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

function sortedLadder(ladder: readonly RichTierLadderRow[]): RichTierLadderRow[] {
  return [...ladder].sort(
    (a, b) => a.tier - b.tier || (a.minRechargeCoins < b.minRechargeCoins ? -1 : 1),
  )
}

export function thresholdForTier(
  tier: number,
  ladder: readonly RichTierLadderRow[] = defaultRichTierLadder(),
): bigint {
  return ladder.find((r) => r.tier === tier)?.minRechargeCoins ?? 0n
}

/** Highest Rich tier for monotonic recharge progress against the given ladder. */
export function computeTier(
  coinsBigInt: bigint,
  ladder: readonly RichTierLadderRow[] = defaultRichTierLadder(),
): number {
  let tier = 0
  for (const row of sortedLadder(ladder)) {
    if (coinsBigInt >= row.minRechargeCoins) {
      tier = row.tier
    } else {
      break
    }
  }
  return tier
}

/** Carryover coins applied at UTC month rollover toward the *next* month’s progress. */
export function applyRetentionRule(
  newTier: number,
  ladder: readonly RichTierLadderRow[] = defaultRichTierLadder(),
): bigint {
  if (newTier <= 2) return 0n
  if (newTier <= 6) return thresholdForTier(newTier - 2, ladder) / 2n
  if (newTier <= 9) return thresholdForTier(newTier - 3, ladder) / 2n
  if (newTier === 10) return thresholdForTier(7, ladder) / 2n
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

type CachedLadderRow = { tier: number; minRechargeCoins?: string; displayName: string }

function parseCachedLadder(raw: string): RichTierLadderRow[] | null {
  try {
    const parsed = JSON.parse(raw) as CachedLadderRow[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    if (parsed[0]?.minRechargeCoins == null) return null
    const ladder: RichTierLadderRow[] = []
    for (const row of parsed) {
      if (!Number.isInteger(row.tier) || row.minRechargeCoins == null) continue
      ladder.push({
        tier: row.tier,
        minRechargeCoins: BigInt(row.minRechargeCoins),
        displayName: row.displayName,
      })
    }
    return ladder.length > 0 ? sortedLadder(ladder) : null
  } catch {
    return null
  }
}

async function loadLadder(): Promise<RichTierLadderRow[]> {
  const key = RedisKeys.richConfig()
  try {
    const cached = await redisClient.get(key)
    if (cached) {
      const parsed = parseCachedLadder(cached)
      if (parsed) return parsed
    }
  } catch {
    /* cold path */
  }
  const rows = await richTierRepository.getConfig()
  const ladder = rows.length > 0 ? sortedLadder(rows) : defaultRichTierLadder()
  try {
    await redisClient.set(
      key,
      JSON.stringify(
        ladder.map((r) => ({
          tier: r.tier,
          minRechargeCoins: r.minRechargeCoins.toString(),
          displayName: r.displayName,
        })),
      ),
      'EX',
      RICH_CONFIG_TTL,
    )
  } catch {
    /* ignore */
  }
  return ladder
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
  ladder: readonly RichTierLadderRow[]
  evaluatedFromYear: number
  evaluatedFromMonth: number
  currentMonthRechargeCoins: bigint
  currentMonthCarryoverCoins: bigint
  currentMonthProgressCoins: bigint
}): RichStateCached {
  const displayName =
    params.badgeTier > 0 ? (params.displayMap.get(params.badgeTier) ?? null) : null
  const progressTier = computeTier(params.currentMonthProgressCoins, params.ladder)
  const maxTier = params.ladder.reduce((m, r) => Math.max(m, r.tier), 0)
  const nextTh = progressTier < maxTier ? thresholdForTier(progressTier + 1, params.ladder) : null
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

    const [richTierRow, ladder] = await Promise.all([
      tx.userRichTier.findUnique({
        where: { userId },
        select: { currentTier: true, carryoverCoins: true },
      }),
      loadLadder(),
    ])
    const carryover = richTierRow?.carryoverCoins ?? 0n
    const previousTier = richTierRow?.currentTier ?? 0
    const liveProgress = carryover + monthTotal
    const liveTier = computeTier(liveProgress, ladder)

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

    const [row, ladder, ym] = await Promise.all([
      richTierRepository.getUserRichTier(userId),
      loadLadder(),
      Promise.resolve(utcYearMonth(utcNow())),
    ])
    const displayMap = new Map(ladder.map((r) => [r.tier, r.displayName]))
    const carry = row?.carryoverCoins ?? 0n
    const monthTotal = await getMonthRechargeCoinsCached(userId, ym.year, ym.month)
    const progress = carry + monthTotal
    const badgeTier = row?.currentTier ?? 0
    const core = buildSnapshotCore({
      badgeTier,
      displayMap,
      ladder,
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
    const ladder = await loadLadder()
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
        const effectiveTier = computeTier(progressTotal, ladder)
        const newCarryover = applyRetentionRule(effectiveTier, ladder)
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
    const ladder = await loadLadder()
    return ladder.map((r) => ({
      tier: r.tier,
      minRechargeCoins: r.minRechargeCoins.toString(),
      displayName: r.displayName,
    }))
  },

  async replaceTierConfig(
    tiers: Array<{ tier: number; minRechargeCoins: string; displayName: string }>,
  ): Promise<Array<{ tier: number; minRechargeCoins: string; displayName: string }>> {
    const parsed = tiers.map((t) => ({
      tier: t.tier,
      minRechargeCoins: BigInt(t.minRechargeCoins),
      displayName: t.displayName.trim(),
    }))
    if (parsed.length !== 10) {
      throw new AppError(400, 'Exactly 10 rich tiers (1–10) are required', 'VALIDATION_ERROR')
    }
    const sorted = [...parsed].sort((a, b) => a.tier - b.tier)
    for (let i = 0; i < 10; i++) {
      const row = sorted[i]!
      if (row.tier !== i + 1) {
        throw new AppError(400, 'Tiers must be uniquely 1 through 10', 'VALIDATION_ERROR')
      }
      if (row.minRechargeCoins <= 0n) {
        throw new AppError(400, 'minRechargeCoins must be a positive integer', 'VALIDATION_ERROR')
      }
      if (!row.displayName) {
        throw new AppError(400, 'displayName is required', 'VALIDATION_ERROR')
      }
      if (i > 0 && row.minRechargeCoins <= sorted[i - 1]!.minRechargeCoins) {
        throw new AppError(
          400,
          'minRechargeCoins must strictly increase with tier',
          'VALIDATION_ERROR',
        )
      }
    }
    await richTierRepository.replaceConfig(sorted)
    try {
      await redisClient.set(
        RedisKeys.richConfig(),
        JSON.stringify(
          sorted.map((r) => ({
            tier: r.tier,
            minRechargeCoins: r.minRechargeCoins.toString(),
            displayName: r.displayName,
          })),
        ),
        'EX',
        RICH_CONFIG_TTL,
      )
    } catch {
      await richTierService.refreshConfigCache()
    }
    return sorted.map((r) => ({
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
