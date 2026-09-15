import { PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { liveStreamRepository } from '../repositories/liveStream.repository'
import { normalHostRewardRepository } from '../repositories/normalHostReward.repository'
import {
  normalHostRewardConfigService,
  type NormalHostTierBigInt,
} from './normalHostRewardConfig.service'
import { effectiveSecondsForSession } from './livestream-reward.service'
import { hasRoyalHostTag } from './royal-host-reward.service'
import { utcDateString, utcStartOfDay } from '../utils/datetime'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

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

export type NormalHostRewardStatusDto =
  | { eligible: false }
  | {
      eligible: true
      rewardDate: string
      streamedSecondsToday: number
      hasTier: false
      nextTier: NormalHostNextTierDto
    }
  | {
      eligible: true
      rewardDate: string
      streamedSecondsToday: number
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

async function loadEligibilityAndInputs(userId: string) {
  const [user, config] = await Promise.all([
    prismaRead.user.findUnique({ where: { id: userId }, select: { adminTags: true } }),
    normalHostRewardConfigService.getConfig(),
  ])
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')
  const eligible = !hasRoyalHostTag(user.adminTags)
  return { eligible, config }
}

async function computeEarningsByWindow(
  userId: string,
  tiers: NormalHostTierBigInt[],
  now: Date,
): Promise<Map<number, bigint>> {
  const distinctWindows = [...new Set(tiers.map((t) => t.windowDays))]
  const sums = await Promise.all(
    distinctWindows.map((days) =>
      normalHostRewardRepository.getQualifyingEarningsForRange(
        userId,
        new Date(now.getTime() - days * 86_400_000),
        now,
      ),
    ),
  )
  return new Map(distinctWindows.map((days, i) => [days, sums[i]!]))
}

export const normalHostRewardService = {
  async getStatus(userId: string): Promise<NormalHostRewardStatusDto> {
    const { eligible, config } = await loadEligibilityAndInputs(userId)
    if (!eligible) return { eligible: false }

    const now = new Date()
    const rewardDate = utcStartOfDay(now)
    const [secondsToday, earningsByWindow, claims] = await Promise.all([
      streamedSecondsToday(userId, rewardDate),
      computeEarningsByWindow(userId, config.tiersBigInt, now),
      normalHostRewardRepository.getClaimsForDate(userId, rewardDate),
    ])

    const currentTier = resolveCurrentTier(config.tiersBigInt, earningsByWindow)

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
        hasTier: false,
        nextTier: {
          thresholdPoints: lowest.thresholdPoints.toString(),
          windowDays: lowest.windowDays,
          earningsSoFar: earningsSoFar.toString(),
          earningsRemaining: earningsRemaining.toString(),
          progressPercent,
        },
      }
    }

    const claimedSlots = new Map(claims.map((c) => [c.hourSlot, c]))
    const totalMinutesToday = Math.floor(secondsToday / 60)
    const unlockedSlots = Math.min(Math.floor(secondsToday / 3600), currentTier.hourCapHours)
    const slots: NormalHostSlotDto[] = []
    for (let hourSlot = 1; hourSlot <= currentTier.hourCapHours; hourSlot++) {
      const claimed = claimedSlots.get(hourSlot)
      const completedMinutes = Math.max(0, Math.min(60, totalMinutesToday - (hourSlot - 1) * 60))
      slots.push({
        claimType: hourSlot,
        hourSlot,
        requiredMinutes: 60,
        completedMinutes,
        unlocked: hourSlot <= unlockedSlots,
        claimed: !!claimed,
        // Not-yet-claimed slots float to the CURRENT tier's rate; claimed slots keep their locked-in amount.
        pointsAmount: claimed
          ? claimed.pointsAmount.toString()
          : currentTier.hourlyRatePoints.toString(),
      })
    }
    const totalClaimedToday = claims.reduce((sum, c) => sum + c.pointsAmount, 0n)

    const currentTierIdx = config.tiersBigInt.findIndex(
      (t) => t.thresholdPoints === currentTier.thresholdPoints,
    )
    const upcomingTier = config.tiersBigInt[currentTierIdx + 1] ?? null
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
    const [secondsToday, earningsByWindow] = await Promise.all([
      streamedSecondsToday(userId, rewardDate),
      computeEarningsByWindow(userId, config.tiersBigInt, now),
    ])
    const currentTier = resolveCurrentTier(config.tiersBigInt, earningsByWindow)
    if (!currentTier) {
      throw new AppError(403, 'No qualifying tier right now', 'NORMAL_HOST_THRESHOLD_NOT_MET')
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
}
