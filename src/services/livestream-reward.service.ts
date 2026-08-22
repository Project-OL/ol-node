import { PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { liveStreamRepository } from '../repositories/liveStream.repository'
import { livestreamRewardRepository } from '../repositories/livestreamReward.repository'
import {
  LIVESTREAM_REWARD_PART_THRESHOLDS_MIN,
  livestreamRewardConfigService,
  type LivestreamRewardEffectiveConfig,
} from './livestreamRewardConfig.service'
import { addUtcDays, utcDateString, utcStartOfDay } from '../utils/datetime'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

/** @deprecated Use livestreamRewardConfigService.getConfig().windowDays */
export const LIVESTREAM_REWARD_WINDOW_DAYS = 7
/** @deprecated Use livestreamRewardConfigService.getConfig().pointsPerHourBigInt */
export const LIVESTREAM_REWARD_PART_POINTS = 2500n

export type LivestreamRewardPartDto = {
  part: number
  thresholdMinutes: number
  points: string
  unlocked: boolean
  claimed: boolean
}

/** One past day (1..N) of the reward window, with each part's final unlocked/claimed status for that day. */
export type LivestreamRewardDayDto = {
  dayIndex: number
  date: string
  parts: LivestreamRewardPartDto[]
}

export type LivestreamRewardStatusDto = {
  eligible: boolean
  dayIndex: number
  streamedMinutesToday: number
  /** Today's parts. Empty once `eligible` is false (past the reward window). */
  parts: LivestreamRewardPartDto[]
  /** Prior days in the window, oldest first. */
  previousRewards: LivestreamRewardDayDto[]
}

/** 1-indexed day of membership, e.g. join day itself is day 1. */
function dayIndexSinceJoin(createdAt: Date, today: Date): number {
  const joinDay = utcStartOfDay(createdAt)
  const diffDays = Math.round((today.getTime() - joinDay.getTime()) / 86_400_000)
  return diffDays + 1
}

/** Sums elapsed minutes across all of a user's LiveStream rows for one UTC calendar day, capping an in-progress session's elapsed time at "now". */
async function streamedMinutesForUserOnDate(userId: string, dayStartUtc: Date): Promise<number> {
  const dayEndUtc = addUtcDays(dayStartUtc, 1)
  const sessions = await liveStreamRepository.getSessionsForUserOnDate(
    userId,
    dayStartUtc,
    dayEndUtc,
  )
  const now = Date.now()
  let totalMs = 0
  for (const s of sessions) {
    if (!s.startedAt) continue
    const start = s.startedAt.getTime()
    const end = s.endedAt ? s.endedAt.getTime() : s.isLive ? now : start
    totalMs += Math.max(0, end - start)
  }
  return Math.floor(totalMs / 60_000)
}

function buildParts(
  streamedMinutes: number,
  claims: { part: number }[],
  config: LivestreamRewardEffectiveConfig,
): LivestreamRewardPartDto[] {
  const claimedParts = new Set(claims.map((c) => c.part))
  return [1, 2].map((part) => ({
    part,
    thresholdMinutes: LIVESTREAM_REWARD_PART_THRESHOLDS_MIN[part]!,
    points: config.pointsPerHourBigInt.toString(),
    unlocked: streamedMinutes >= LIVESTREAM_REWARD_PART_THRESHOLDS_MIN[part]!,
    claimed: claimedParts.has(part),
  }))
}

/** Builds the day-1..dayCount breakdown (oldest first) from one range query each for sessions and claims. */
async function buildPreviousRewards(
  userId: string,
  joinDay: Date,
  dayCount: number,
  config: LivestreamRewardEffectiveConfig,
): Promise<LivestreamRewardDayDto[]> {
  const rangeEnd = addUtcDays(joinDay, dayCount)
  const [sessions, claims] = await Promise.all([
    liveStreamRepository.getSessionsForUserInRange(userId, joinDay, rangeEnd),
    livestreamRewardRepository.getClaimsForDateRange(userId, joinDay, rangeEnd),
  ])

  const now = Date.now()
  const streamedMsByDate = new Map<string, number>()
  for (const s of sessions) {
    if (!s.startedAt) continue
    const dateKey = utcDateString(s.startedAt)
    const start = s.startedAt.getTime()
    const end = s.endedAt ? s.endedAt.getTime() : s.isLive ? now : start
    streamedMsByDate.set(dateKey, (streamedMsByDate.get(dateKey) ?? 0) + Math.max(0, end - start))
  }

  const claimsByDate = new Map<string, { part: number }[]>()
  for (const c of claims) {
    const dateKey = utcDateString(c.claimDate)
    const list = claimsByDate.get(dateKey)
    if (list) list.push(c)
    else claimsByDate.set(dateKey, [c])
  }

  const days: LivestreamRewardDayDto[] = []
  for (let dayIndex = 1; dayIndex <= dayCount; dayIndex++) {
    const date = addUtcDays(joinDay, dayIndex - 1)
    const dateKey = utcDateString(date)
    const streamedMinutes = Math.floor((streamedMsByDate.get(dateKey) ?? 0) / 60_000)
    days.push({
      dayIndex,
      date: dateKey,
      parts: buildParts(streamedMinutes, claimsByDate.get(dateKey) ?? [], config),
    })
  }
  return days
}

export const livestreamRewardService = {
  /**
   * `parts` covers today only (empty once the window has closed). `previousRewards` covers
   * completed days in the window: days 1..dayIndex-1 while eligible, or all N once
   * `dayIndex` has moved past the window — so history stays visible after the window ends.
   */
  async getStatus(userId: string): Promise<LivestreamRewardStatusDto> {
    const [user, config] = await Promise.all([
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { createdAt: true },
      }),
      livestreamRewardConfigService.getConfig(),
    ])
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')

    const today = utcStartOfDay(new Date())
    const joinDay = utcStartOfDay(user.createdAt)
    const dayIndex = dayIndexSinceJoin(user.createdAt, today)
    const eligible = dayIndex >= 1 && dayIndex <= config.windowDays

    let streamedMinutesToday = 0
    let parts: LivestreamRewardPartDto[] = []
    if (eligible) {
      streamedMinutesToday = await streamedMinutesForUserOnDate(userId, today)
      const claims = await livestreamRewardRepository.getClaimsForDate(userId, today)
      parts = buildParts(streamedMinutesToday, claims, config)
    }

    const previousDayCount = eligible
      ? Math.min(dayIndex - 1, config.windowDays)
      : config.windowDays
    const previousRewards =
      previousDayCount > 0
        ? await buildPreviousRewards(userId, joinDay, previousDayCount, config)
        : []

    return {
      eligible,
      dayIndex,
      streamedMinutesToday,
      parts,
      previousRewards,
    }
  },

  async claimPart(
    userId: string,
    part: number,
  ): Promise<{ part: number; pointsAmount: string; claimedAt: string }> {
    if (part !== 1 && part !== 2) {
      throw new AppError(400, 'Invalid reward part', 'INVALID_REQUEST')
    }

    const [user, config] = await Promise.all([
      prismaRead.user.findUnique({
        where: { id: userId },
        select: { createdAt: true },
      }),
      livestreamRewardConfigService.getConfig(),
    ])
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')

    const today = utcStartOfDay(new Date())
    const dayIndex = dayIndexSinceJoin(user.createdAt, today)
    if (dayIndex < 1 || dayIndex > config.windowDays) {
      throw new AppError(
        403,
        'Livestream reward window is closed',
        'LIVESTREAM_REWARD_WINDOW_CLOSED',
      )
    }

    const streamedMinutesToday = await streamedMinutesForUserOnDate(userId, today)
    const threshold = LIVESTREAM_REWARD_PART_THRESHOLDS_MIN[part]!
    if (streamedMinutesToday < threshold) {
      throw new AppError(
        403,
        `Stream at least ${threshold} minutes today to claim this part`,
        'LIVESTREAM_REWARD_THRESHOLD_NOT_MET',
      )
    }

    const pointsAmount = config.pointsPerHourBigInt
    const claimDateStr = utcDateString(today)
    const idempotencyKey = `livestream-reward:${userId}:${claimDateStr}:${part}`

    try {
      await withSerializationRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const existing = await tx.liveStreamRewardClaim.findUnique({
              where: { userId_claimDate_part: { userId, claimDate: today, part } },
            })
            if (existing) {
              throw new AppError(409, 'Already claimed', 'ALREADY_CLAIMED')
            }

            // Livestream reward points are excluded from livestream XP, wealth/rich
            // tier (never touched by point credits), and agency commission (this
            // tx type is not in point-wallet's commission-eligible set).
            const credit = await pointWalletService.creditInTransaction(
              userId,
              pointsAmount,
              PointTxType.LIVESTREAM_STREAK_REWARD,
              tx,
              {
                idempotencyKey,
                description: 'Livestream daily reward',
                metadata: { claimDate: claimDateStr, part },
                applyLivestreamLevel: false,
              },
            )

            await livestreamRewardRepository.insertClaim(
              {
                userId,
                claimDate: today,
                part,
                pointsAmount,
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
      part,
      pointsAmount: pointsAmount.toString(),
      claimedAt: new Date().toISOString(),
    }
  },
}
