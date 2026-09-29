import { PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { liveStreamRepository } from '../repositories/liveStream.repository'
import {
  normalHostRewardRepository,
  type NormalHostDailyTierInsert,
} from '../repositories/normalHostReward.repository'
import {
  normalHostRewardConfigService,
  type NormalHostTierBigInt,
} from './normalHostRewardConfig.service'
import { dayIndexSinceJoin, effectiveSecondsForSession } from './livestream-reward.service'
import { livestreamRewardConfigService } from './livestreamRewardConfig.service'
import { hasRoyalHostTag } from '../utils/royalHostTag'
import { addUtcDays, utcDateString, utcStartOfDay } from '../utils/datetime'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000
const DAILY_TIER_INSERT_CHUNK = 1000

export type NormalHostSlotDto = {
  /** Send this as `hourSlot` in the claim request. */
  claimType: number
  hourSlot: number
  requiredMinutes: number
  completedMinutes: number
  unlocked: boolean
  claimed: boolean
  pointsAmount: string
}

export type NormalHostNextTierDto = {
  thresholdPoints: string
  windowDays: number
  earningsSoFar: string
  earningsRemaining: string
  progressPercent: number
}

export type NormalHostUpcomingTierDto = {
  thresholdPoints: string
  hourlyRatePoints: string
  hourCapHours: number
  windowDays: number
  earnedPoints: string
  remainingPoints: string
  progressPercent: number
}

/** Full admin-configured ladder, no progress fields — lets the client render the whole ladder
 * (or derive "the tier after next") without a second request. Always present, regardless of hasTier. */
export type NormalHostTierListItemDto = {
  thresholdPoints: string
  hourlyRatePoints: string
  hourCapHours: number
  windowDays: number
}

export type NormalHostRewardStatusDto =
  | { eligible: false }
  | {
      eligible: true
      rewardDate: string
      streamedSecondsToday: number
      /**
       * Today 00:00 UTC: start of the tier window's current day. The tier can rise any time
       * today as receiving arrives, and never drops below the tier held at this instant.
       */
      tierEvaluatedAt: string
      /** Next 00:00 UTC — the oldest day leaves the window; the only time the tier can drop. */
      nextEvaluationAt: string
      hasTier: false
      nextTier: NormalHostNextTierDto
      tiers: NormalHostTierListItemDto[]
    }
  | {
      eligible: true
      rewardDate: string
      streamedSecondsToday: number
      tierEvaluatedAt: string
      nextEvaluationAt: string
      hasTier: true
      currentTier: {
        thresholdPoints: string
        hourlyRatePoints: string
        hourCapHours: number
        windowDays: number
      }
      /** null once the user is already on the highest configured tier. */
      nextTier: NormalHostUpcomingTierDto | null
      slots: NormalHostSlotDto[]
      totalClaimedToday: string
      tiers: NormalHostTierListItemDto[]
    }

async function streamedSecondsToday(userId: string, dayStartUtc: Date): Promise<number> {
  const sessions = await liveStreamRepository.getSessionsForUserOnDate(
    userId,
    dayStartUtc,
    new Date(dayStartUtc.getTime() + 86_400_000),
  )
  const perSession = await Promise.all(sessions.map(effectiveSecondsForSession))
  return perSession.reduce((sum, sec) => sum + sec, 0)
}

/** Highest-threshold tier whose earnings over ITS OWN window meets its threshold, or null. */
function resolveCurrentTier(
  tiers: NormalHostTierBigInt[],
  earningsByWindowDays: Map<number, bigint>,
): NormalHostTierBigInt | null {
  let best: NormalHostTierBigInt | null = null
  for (const tier of tiers) {
    const earnings = earningsByWindowDays.get(tier.windowDays) ?? 0n
    if (earnings >= tier.thresholdPoints) {
      if (!best || tier.thresholdPoints > best.thresholdPoints) best = tier
    }
  }
  return best
}

/**
 * Cheapest tier above `currentTier` whose hour cap covers `hourSlot` — the target the user
 * must reach to claim it. Hour caps aren't validated as ascending, so a lower tier the user
 * already passed may cover the slot; those are skipped since they can't be the next target.
 */
function lowestTierCoveringSlot(
  tiers: NormalHostTierBigInt[],
  hourSlot: number,
  currentTier: NormalHostTierBigInt | null,
): NormalHostTierBigInt | null {
  let best: NormalHostTierBigInt | null = null
  for (const tier of tiers) {
    if (tier.hourCapHours < hourSlot) continue
    if (currentTier && tier.thresholdPoints <= currentTier.thresholdPoints) continue
    if (!best || tier.thresholdPoints < best.thresholdPoints) best = tier
  }
  return best
}

/**
 * 100000n → "100K", 1500000n → "1.5M". Rounds UP to one decimal so a "receive X more"
 * figure never understates what's still needed (1440000n → "1.5M", 999999n → "1M").
 */
function formatCompactPoints(points: bigint): string {
  if (points < 1_000n) return points.toString()
  const units: Array<[bigint, string]> = [
    [1_000n, 'K'],
    [1_000_000n, 'M'],
    [1_000_000_000n, 'B'],
  ]
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i]!
    const tenths = (points * 10n + size - 1n) / size
    if (tenths >= 10_000n && i < units.length - 1) continue
    const whole = tenths / 10n
    const frac = tenths % 10n
    return `${whole}${frac > 0n ? `.${frac}` : ''}${suffix}`
  }
  return points.toString()
}

/**
 * `earningsByWindowDays` is receiving so far in the tier window (00:00 UTC `windowDays`
 * back → now). Reaching a target applies immediately, so `remaining` is normally > 0 here;
 * the "reached" branch only covers a race with a gift landing mid-request.
 */
function tierTargetNotMetError(
  target: NormalHostTierBigInt,
  earningsByWindowDays: Map<number, bigint>,
): AppError {
  const earned = earningsByWindowDays.get(target.windowDays) ?? 0n
  const remaining = target.thresholdPoints > earned ? target.thresholdPoints - earned : 0n
  const days = target.windowDays === 1 ? '24 hours' : `${target.windowDays} days`
  const targetLabel = formatCompactPoints(target.thresholdPoints)
  return new AppError(
    403,
    remaining > 0n
      ? `Unlock the ${targetLabel} receiving target first — receive ` +
          `${formatCompactPoints(remaining)} more within the last ${days}`
      : `You've reached the ${targetLabel} receiving target — please try again`,
    'NORMAL_HOST_THRESHOLD_NOT_MET',
    {
      reason: 'TIER_TARGET_NOT_MET',
      requiredPoints: target.thresholdPoints.toString(),
      earnedPoints: earned.toString(),
      remainingPoints: remaining.toString(),
      windowDays: target.windowDays,
    },
  )
}

function buildTierList(tiers: NormalHostTierBigInt[]): NormalHostTierListItemDto[] {
  return tiers.map((t) => ({
    thresholdPoints: t.thresholdPoints.toString(),
    hourlyRatePoints: t.hourlyRatePoints.toString(),
    hourCapHours: t.hourCapHours,
    windowDays: t.windowDays,
  }))
}

async function loadEligibilityAndInputs(userId: string) {
  const [user, config, livestreamConfig] = await Promise.all([
    prismaRead.user.findUnique({
      where: { id: userId },
      select: { adminTags: true, createdAt: true },
    }),
    normalHostRewardConfigService.getConfig(),
    livestreamRewardConfigService.getConfig(),
  ])
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')

  // Normal Host reward starts only once the livestream (7-day new-host) reward window has
  // fully closed, and never applies to Royal Host-tagged users (they're on the royal ladder).
  const today = utcStartOfDay(new Date())
  const dayIndex = dayIndexSinceJoin(user.createdAt, today)
  const eligible = !hasRoyalHostTag(user.adminTags) && dayIndex > livestreamConfig.windowDays
  return { eligible, config }
}

/**
 * Qualifying receiving over each distinct tier window: from 00:00 UTC `windowDays` days
 * before `end`'s day, up to `end`. The start only moves at 00:00 UTC, so during a day the
 * sums only grow (a tier can rise) and a day's receiving drops out at 00:00 (the only time
 * a tier can fall). With `end` = a UTC midnight this is the completed-days window.
 */
async function computeEarningsByWindow(
  userId: string,
  tiers: NormalHostTierBigInt[],
  end: Date,
): Promise<Map<number, bigint>> {
  const dayStart = utcStartOfDay(end)
  const distinctWindows = [...new Set(tiers.map((t) => t.windowDays))]
  const sums = await Promise.all(
    distinctWindows.map((days) =>
      normalHostRewardRepository.getQualifyingEarningsForRange(
        userId,
        addUtcDays(dayStart, -days),
        end,
      ),
    ),
  )
  return new Map(distinctWindows.map((days, i) => [days, sums[i]!]))
}

/** Higher-threshold of two tiers (`a` wins ties, so the recorded day tier is kept). */
function higherTier(
  a: NormalHostTierBigInt | null,
  b: NormalHostTierBigInt | null,
): NormalHostTierBigInt | null {
  if (!a) return b
  if (!b) return a
  return b.thresholdPoints > a.thresholdPoints ? b : a
}

function dailyTierRow(
  userId: string,
  rewardDate: Date,
  tier: NormalHostTierBigInt | null,
  earningsByWindow: Map<number, bigint>,
  source: NormalHostDailyTierInsert['source'],
): NormalHostDailyTierInsert {
  return {
    userId,
    rewardDate,
    thresholdPoints: tier?.thresholdPoints ?? null,
    hourlyRatePoints: tier?.hourlyRatePoints ?? null,
    hourCapHours: tier?.hourCapHours ?? null,
    windowDays: tier?.windowDays ?? null,
    earningsByWindow: Object.fromEntries(
      [...earningsByWindow].map(([days, sum]) => [String(days), sum.toString()]),
    ),
    source,
  }
}

/**
 * The day's **floor** tier for `rewardDate` (a UTC midnight): receiving over each window
 * ending at that 00:00 UTC. The live tier can only rise above it during the day (see
 * {@link computeEarningsByWindow}); the floor guarantees it never drops mid-day, even if
 * an admin edits the ladder. The row is written by the 00:00 UTC job; if the job hasn't
 * reached this user yet, it is computed and written here with the same inputs.
 */
async function getDayTier(
  userId: string,
  rewardDate: Date,
  tiers: NormalHostTierBigInt[],
): Promise<NormalHostTierBigInt | null> {
  let row = await normalHostRewardRepository.getDailyTier(userId, rewardDate)
  if (!row) {
    const earnings = await computeEarningsByWindow(userId, tiers, rewardDate)
    const tier = resolveCurrentTier(tiers, earnings)
    await normalHostRewardRepository.insertDailyTiers([
      dailyTierRow(userId, rewardDate, tier, earnings, 'lazy'),
    ])
    // Re-read so a concurrent writer (job or another request) wins consistently.
    row = await normalHostRewardRepository.getDailyTier(userId, rewardDate)
    if (!row) return tier
  }
  if (
    row.thresholdPoints === null ||
    row.hourlyRatePoints === null ||
    row.hourCapHours === null ||
    row.windowDays === null
  ) {
    return null
  }
  return {
    thresholdPoints: row.thresholdPoints,
    hourlyRatePoints: row.hourlyRatePoints,
    hourCapHours: row.hourCapHours,
    windowDays: row.windowDays,
  }
}

/** Cheapest configured tier strictly above `current`, or null at the top of the ladder. */
function tierAbove(
  tiers: NormalHostTierBigInt[],
  current: NormalHostTierBigInt,
): NormalHostTierBigInt | null {
  let best: NormalHostTierBigInt | null = null
  for (const t of tiers) {
    if (t.thresholdPoints <= current.thresholdPoints) continue
    if (!best || t.thresholdPoints < best.thresholdPoints) best = t
  }
  return best
}

export const normalHostRewardService = {
  async getStatus(userId: string): Promise<NormalHostRewardStatusDto> {
    const { eligible, config } = await loadEligibilityAndInputs(userId)
    if (!eligible) return { eligible: false }

    const now = new Date()
    const rewardDate = utcStartOfDay(now)
    const nextEvaluation = addUtcDays(rewardDate, 1)
    // Tier = higher of today's 00:00 floor and the tier reached so far today (window
    // 00:00 UTC N days back → now), so it can rise during the day but never fall.
    const [secondsToday, earningsByWindow, claims, dayFloor] = await Promise.all([
      streamedSecondsToday(userId, rewardDate),
      computeEarningsByWindow(userId, config.tiersBigInt, now),
      normalHostRewardRepository.getClaimsForDate(userId, rewardDate),
      getDayTier(userId, rewardDate, config.tiersBigInt),
    ])
    const currentTier = higherTier(
      dayFloor,
      resolveCurrentTier(config.tiersBigInt, earningsByWindow),
    )
    const evaluation = {
      tierEvaluatedAt: rewardDate.toISOString(),
      nextEvaluationAt: nextEvaluation.toISOString(),
    }

    if (!currentTier) {
      const lowest = config.tiersBigInt.reduce((min, t) =>
        t.thresholdPoints < min.thresholdPoints ? t : min,
      )
      const earningsSoFar = earningsByWindow.get(lowest.windowDays) ?? 0n
      const earningsRemaining =
        lowest.thresholdPoints > earningsSoFar ? lowest.thresholdPoints - earningsSoFar : 0n
      const progressPercent =
        lowest.thresholdPoints > 0n
          ? Math.min(100, Number((earningsSoFar * 100n) / lowest.thresholdPoints))
          : 0
      return {
        eligible: true,
        rewardDate: utcDateString(rewardDate),
        streamedSecondsToday: secondsToday,
        ...evaluation,
        hasTier: false,
        nextTier: {
          thresholdPoints: lowest.thresholdPoints.toString(),
          windowDays: lowest.windowDays,
          earningsSoFar: earningsSoFar.toString(),
          earningsRemaining: earningsRemaining.toString(),
          progressPercent,
        },
        tiers: buildTierList(config.tiersBigInt),
      }
    }

    const claimedSlots = new Map(claims.map((c) => [c.hourSlot, c]))
    const totalMinutesToday = Math.floor(secondsToday / 60)
    const unlockedSlots = Math.min(Math.floor(secondsToday / 3600), currentTier.hourCapHours)
    // Claims made before the daily lock existed can sit above today's cap; keep showing them.
    const lastSlot = Math.max(currentTier.hourCapHours, ...claims.map((c) => c.hourSlot))
    const slots: NormalHostSlotDto[] = []
    for (let hourSlot = 1; hourSlot <= lastSlot; hourSlot++) {
      const claimed = claimedSlots.get(hourSlot)
      const completedMinutes = Math.max(0, Math.min(60, totalMinutesToday - (hourSlot - 1) * 60))
      slots.push({
        claimType: hourSlot,
        hourSlot,
        requiredMinutes: 60,
        completedMinutes,
        unlocked: hourSlot <= unlockedSlots,
        claimed: !!claimed,
        // Unclaimed slots pay today's (fixed) tier rate; claimed slots show what was paid.
        pointsAmount: claimed
          ? claimed.pointsAmount.toString()
          : currentTier.hourlyRatePoints.toString(),
      })
    }
    const totalClaimedToday = claims.reduce((sum, c) => sum + c.pointsAmount, 0n)

    const upcomingTier = tierAbove(config.tiersBigInt, currentTier)
    let nextTier: NormalHostUpcomingTierDto | null = null
    if (upcomingTier) {
      const earned = earningsByWindow.get(upcomingTier.windowDays) ?? 0n
      const remaining =
        earned >= upcomingTier.thresholdPoints ? 0n : upcomingTier.thresholdPoints - earned
      nextTier = {
        thresholdPoints: upcomingTier.thresholdPoints.toString(),
        hourlyRatePoints: upcomingTier.hourlyRatePoints.toString(),
        hourCapHours: upcomingTier.hourCapHours,
        windowDays: upcomingTier.windowDays,
        earnedPoints: earned.toString(),
        remainingPoints: remaining.toString(),
        progressPercent:
          upcomingTier.thresholdPoints > 0n
            ? Math.min(100, Number((earned * 100n) / upcomingTier.thresholdPoints))
            : 100,
      }
    }

    return {
      eligible: true,
      rewardDate: utcDateString(rewardDate),
      streamedSecondsToday: secondsToday,
      ...evaluation,
      hasTier: true,
      currentTier: {
        thresholdPoints: currentTier.thresholdPoints.toString(),
        hourlyRatePoints: currentTier.hourlyRatePoints.toString(),
        hourCapHours: currentTier.hourCapHours,
        windowDays: currentTier.windowDays,
      },
      nextTier,
      slots,
      totalClaimedToday: totalClaimedToday.toString(),
      tiers: buildTierList(config.tiersBigInt),
    }
  },

  async claimReward(
    userId: string,
    hourSlot: number,
  ): Promise<{ hourSlot: number; pointsAmount: string; claimedAt: string }> {
    const { eligible, config } = await loadEligibilityAndInputs(userId)
    if (!eligible) {
      throw new AppError(403, 'Not eligible for Normal Host reward', 'NORMAL_HOST_NOT_ELIGIBLE')
    }
    if (!Number.isInteger(hourSlot) || hourSlot < 1) {
      throw new AppError(400, 'Invalid hour slot', 'INVALID_REQUEST')
    }

    const now = new Date()
    const rewardDate = utcStartOfDay(now)
    // Pays the higher of today's 00:00 floor and the tier reached so far today — the same
    // tier getStatus shows at this moment.
    const [secondsToday, dayFloor, liveEarnings] = await Promise.all([
      streamedSecondsToday(userId, rewardDate),
      getDayTier(userId, rewardDate, config.tiersBigInt),
      computeEarningsByWindow(userId, config.tiersBigInt, now),
    ])
    const currentTier = higherTier(dayFloor, resolveCurrentTier(config.tiersBigInt, liveEarnings))
    if (!currentTier || hourSlot > currentTier.hourCapHours) {
      // Name the exact receiving target that unlocks THIS slot, not a generic "no tier".
      const target = lowestTierCoveringSlot(config.tiersBigInt, hourSlot, currentTier)
      if (!target) {
        if (currentTier) {
          throw new AppError(
            403,
            'This hour slot is not available on your current tier',
            'NORMAL_HOST_THRESHOLD_NOT_MET',
          )
        }
        throw new AppError(400, 'Invalid hour slot', 'INVALID_REQUEST')
      }
      throw tierTargetNotMetError(target, liveEarnings)
    }
    const unlockedSlots = Math.min(Math.floor(secondsToday / 3600), currentTier.hourCapHours)
    if (hourSlot > unlockedSlots) {
      throw new AppError(
        403,
        `Complete ${hourSlot} hour(s) live today to claim this slot`,
        'NORMAL_HOST_THRESHOLD_NOT_MET',
      )
    }

    const pointsAmount = currentTier.hourlyRatePoints
    const rewardDateStr = utcDateString(rewardDate)
    const idempotencyKey = `normal-host-reward:${userId}:${rewardDateStr}:${hourSlot}`

    try {
      await withSerializationRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const existing = await tx.normalHostRewardClaim.findUnique({
              where: { userId_rewardDate_hourSlot: { userId, rewardDate, hourSlot } },
            })
            if (existing) {
              throw new AppError(409, 'Already claimed', 'ALREADY_CLAIMED')
            }

            const credit = await pointWalletService.creditInTransaction(
              userId,
              pointsAmount,
              PointTxType.NORMAL_HOST_REWARD,
              tx,
              {
                idempotencyKey,
                description: 'Normal Host daily reward',
                metadata: {
                  rewardDate: rewardDateStr,
                  hourSlot,
                  tierThresholdPoints: currentTier.thresholdPoints.toString(),
                },
                applyLivestreamLevel: false,
              },
            )

            await normalHostRewardRepository.insertClaim(
              {
                userId,
                rewardDate,
                hourSlot,
                pointsAmount,
                tierThresholdPoints: currentTier.thresholdPoints,
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
        throw new AppError(409, 'Already claimed', 'ALREADY_CLAIMED')
      }
      throw err
    }

    await walletService.adjustPointBalanceCache(userId, pointsAmount)

    return {
      hourSlot,
      pointsAmount: pointsAmount.toString(),
      claimedAt: new Date().toISOString(),
    }
  },

  /**
   * Evaluate every user with qualifying receiving in the longest tier window before
   * `rewardDate` (a UTC midnight) and record their tier for that day. Users with no
   * receiving get their (tierless) row lazily on first read. Existing rows are kept, so
   * re-running for a date is safe and never changes a tier already shown or paid.
   */
  async recomputeDailyTiers(rewardDate: Date): Promise<{
    rewardDate: string
    candidates: number
    withTier: number
    inserted: number
  }> {
    const dayStart = utcStartOfDay(rewardDate)
    const { tiersBigInt: tiers } = await normalHostRewardConfigService.getConfig()
    const windows = [...new Set(tiers.map((t) => t.windowDays))]
    const byWindow = new Map<number, Map<string, bigint>>()
    for (const days of windows) {
      byWindow.set(
        days,
        await normalHostRewardRepository.getQualifyingEarningsByUserForRange(
          addUtcDays(dayStart, -days),
          dayStart,
        ),
      )
    }

    const userIds = new Set<string>()
    for (const m of byWindow.values()) for (const id of m.keys()) userIds.add(id)

    let withTier = 0
    const rows: NormalHostDailyTierInsert[] = []
    for (const userId of userIds) {
      const earnings = new Map(windows.map((d) => [d, byWindow.get(d)!.get(userId) ?? 0n]))
      const tier = resolveCurrentTier(tiers, earnings)
      if (tier) withTier++
      rows.push(dailyTierRow(userId, dayStart, tier, earnings, 'job'))
    }

    let inserted = 0
    for (let i = 0; i < rows.length; i += DAILY_TIER_INSERT_CHUNK) {
      inserted += await normalHostRewardRepository.insertDailyTiers(
        rows.slice(i, i + DAILY_TIER_INSERT_CHUNK),
      )
    }
    return { rewardDate: utcDateString(dayStart), candidates: rows.length, withTier, inserted }
  },
}
