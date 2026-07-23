import { PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { liveStreamRepository } from '../repositories/liveStream.repository'
import { livestreamRewardRepository } from '../repositories/livestreamReward.repository'
import { addUtcDays, utcDateString, utcStartOfDay } from '../utils/datetime'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

/** First-N-days-from-join eligibility window for the livestream daily reward. */
export const LIVESTREAM_REWARD_WINDOW_DAYS = 7
export const LIVESTREAM_REWARD_PART_POINTS = 2500n
export const LIVESTREAM_REWARD_PART_THRESHOLDS_MIN: Record<number, number> = { 1: 60, 2: 120 }

export type LivestreamRewardPartDto = {
  part: number
  thresholdMinutes: number
  points: string
  unlocked: boolean
  claimed: boolean
}

export type LivestreamRewardStatusDto = {
  eligible: boolean
  dayIndex: number
  streamedMinutesToday: number
  parts: LivestreamRewardPartDto[]
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
  streamedMinutesToday: number,
  claims: { part: number }[],
): LivestreamRewardPartDto[] {
  const claimedParts = new Set(claims.map((c) => c.part))
  return [1, 2].map((part) => ({
    part,
    thresholdMinutes: LIVESTREAM_REWARD_PART_THRESHOLDS_MIN[part]!,
    points: LIVESTREAM_REWARD_PART_POINTS.toString(),
    unlocked: streamedMinutesToday >= LIVESTREAM_REWARD_PART_THRESHOLDS_MIN[part]!,
    claimed: claimedParts.has(part),
  }))
}

export const livestreamRewardService = {
  async getStatus(userId: string): Promise<LivestreamRewardStatusDto> {
    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    })
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')

    const today = utcStartOfDay(new Date())
    const dayIndex = dayIndexSinceJoin(user.createdAt, today)
    const eligible = dayIndex >= 1 && dayIndex <= LIVESTREAM_REWARD_WINDOW_DAYS

    if (!eligible) {
      return { eligible: false, dayIndex, streamedMinutesToday: 0, parts: buildParts(0, []) }
    }

    const streamedMinutesToday = await streamedMinutesForUserOnDate(userId, today)
    const claims = await livestreamRewardRepository.getClaimsForDate(userId, today)

    return {
      eligible: true,
      dayIndex,
      streamedMinutesToday,
      parts: buildParts(streamedMinutesToday, claims),
    }
  },

  async claimPart(
    userId: string,
    part: number,
  ): Promise<{ part: number; pointsAmount: string; claimedAt: string }> {
    if (part !== 1 && part !== 2) {
      throw new AppError(400, 'Invalid reward part', 'INVALID_REQUEST')
    }

    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      select: { createdAt: true },
    })
    if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')

    const today = utcStartOfDay(new Date())
    const dayIndex = dayIndexSinceJoin(user.createdAt, today)
    if (dayIndex < 1 || dayIndex > LIVESTREAM_REWARD_WINDOW_DAYS) {
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
              LIVESTREAM_REWARD_PART_POINTS,
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
                pointsAmount: LIVESTREAM_REWARD_PART_POINTS,
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

    await walletService.adjustPointBalanceCache(userId, LIVESTREAM_REWARD_PART_POINTS)

    return {
      part,
      pointsAmount: LIVESTREAM_REWARD_PART_POINTS.toString(),
      claimedAt: new Date().toISOString(),
    }
  },
}
