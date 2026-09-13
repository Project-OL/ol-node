import { PointTxType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { pointWalletService } from './point-wallet.service'
import { walletService } from './wallet.service'
import { liveStreamRepository } from '../repositories/liveStream.repository'
import { royalHostRewardRepository } from '../repositories/royalHostReward.repository'
import {
  royalHostRewardConfigService,
  type RoyalHostRewardEffectiveConfig,
} from './royalHostRewardConfig.service'
import { effectiveSecondsForSession } from './livestream-reward.service'
import { addUtcDays, utcDateString, utcStartOfWeek } from '../utils/datetime'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000

const ROYAL_HOST_TAG = 'royal host'

export type RoyalHostTimingStepDto = {
  points: string
  unlocked: boolean
  claimed: boolean
}

export type RoyalHostGiftingTierStatusDto = {
  tierIndex: number
  earningThreshold: string
  cumulativePoints: string
  incrementPoints: string
  unlocked: boolean
  claimed: boolean
  earningsRemaining: string
  progressPercent: number
}

export type RoyalHostRewardStatusDto =
  | { eligible: false }
  | {
      eligible: true
      weekStart: string
      weekEndsInSeconds: number
      requiredWeeklyHours: number
      dailyHoursCapMinutes: number
      streamedSecondsThisWeek: number
      timingProgressPercent: number
      timingRequirementMet: boolean
      weeklyEarningsPoints: string
      timing: {
        step1: RoyalHostTimingStepDto
        step2: RoyalHostTimingStepDto & { earningThreshold: string }
        totalClaimed: string
      }
      gifting: {
        tiers: RoyalHostGiftingTierStatusDto[]
        totalClaimed: string
      }
      totalRewardPointsThisWeek: string
    }

function hasRoyalHostTag(adminTags: string[]): boolean {
  return adminTags.some((t) => t.trim().toLowerCase() === ROYAL_HOST_TAG)
}

async function streamedSecondsForWeek(
  userId: string,
  weekStart: Date,
  dailyCapSeconds: number,
): Promise<number> {
  const weekEnd = addUtcDays(weekStart, 7)
  const sessions = await liveStreamRepository.getSessionsForUserInRange(userId, weekStart, weekEnd)

  const secByDate = new Map<string, number>()
  const perSession = await Promise.all(
    sessions.map(async (s) => {
      if (!s.startedAt) return null
      const sec = await effectiveSecondsForSession(s)
      return { dateKey: utcDateString(s.startedAt), sec }
    }),
  )
  for (const row of perSession) {
    if (!row) continue
    secByDate.set(row.dateKey, (secByDate.get(row.dateKey) ?? 0) + row.sec)
  }

  let total = 0
  for (const sec of secByDate.values()) {
    total += Math.min(sec, dailyCapSeconds)
  }
  return total
}

function buildGiftingTiers(
  config: RoyalHostRewardEffectiveConfig,
  weeklyEarnings: bigint,
  claimedTypes: Set<string>,
): RoyalHostGiftingTierStatusDto[] {
  let prevCumulative = 0n
  return config.giftingTiersBigInt.map((tier, i) => {
    const tierIndex = i + 1
    const rewardType = `GIFTING_TIER_${tierIndex}`
    const incrementPoints = tier.cumulativePoints - prevCumulative
    const unlocked = weeklyEarnings >= tier.threshold
    const earningsRemaining = unlocked ? 0n : tier.threshold - weeklyEarnings
    const progressPercent = unlocked
      ? 100
      : tier.threshold > 0n
        ? Math.min(100, Number((weeklyEarnings * 100n) / tier.threshold))
        : 0
    const dto: RoyalHostGiftingTierStatusDto = {
      tierIndex,
      earningThreshold: tier.threshold.toString(),
      cumulativePoints: tier.cumulativePoints.toString(),
      incrementPoints: incrementPoints.toString(),
      unlocked,
      claimed: claimedTypes.has(rewardType),
      earningsRemaining: earningsRemaining.toString(),
      progressPercent,
    }
    prevCumulative = tier.cumulativePoints
    return dto
  })
}

async function loadStatusInputs(userId: string) {
  const [user, config] = await Promise.all([
    prismaRead.user.findUnique({ where: { id: userId }, select: { adminTags: true } }),
    royalHostRewardConfigService.getConfig(),
  ])
  if (!user) throw new AppError(404, 'User not found', 'NOT_FOUND')
  const eligible = hasRoyalHostTag(user.adminTags)
  return { eligible, config }
}

export const royalHostRewardService = {
  async getStatus(userId: string): Promise<RoyalHostRewardStatusDto> {
    const { eligible, config } = await loadStatusInputs(userId)
    if (!eligible) return { eligible: false }

    const now = new Date()
    const weekStart = utcStartOfWeek(now)
    const weekEnd = addUtcDays(weekStart, 7)
    const dailyCapSeconds = config.dailyHoursCapMinutes * 60
    const requiredSeconds = config.weeklyHoursRequired * 3600

    const [streamedSecondsThisWeek, weeklyEarningsPoints, claims] = await Promise.all([
      streamedSecondsForWeek(userId, weekStart, dailyCapSeconds),
      royalHostRewardRepository.getQualifyingEarningsForRange(userId, weekStart, weekEnd),
      royalHostRewardRepository.getClaimsForWeek(userId, weekStart),
    ])

    const claimedTypes = new Set(claims.map((c) => c.rewardType))
    const timingRequirementMet = streamedSecondsThisWeek >= requiredSeconds
    const step1Unlocked = timingRequirementMet
    const step2Unlocked =
      timingRequirementMet && weeklyEarningsPoints >= config.timingStep2EarningThresholdBigInt

    const timingClaimedTotal =
      (claimedTypes.has('TIMING_STEP_1') ? config.timingStep1PointsBigInt : 0n) +
      (claimedTypes.has('TIMING_STEP_2') ? config.timingStep2PointsBigInt : 0n)

    const gifting = buildGiftingTiers(config, weeklyEarningsPoints, claimedTypes)
    const giftingClaimedTotal = claims
      .filter((c) => c.rewardType.startsWith('GIFTING_TIER_'))
      .reduce((sum, c) => sum + c.pointsAmount, 0n)

    return {
      eligible: true,
      weekStart: utcDateString(weekStart),
      weekEndsInSeconds: Math.max(0, Math.floor((weekEnd.getTime() - now.getTime()) / 1000)),
      requiredWeeklyHours: config.weeklyHoursRequired,
      dailyHoursCapMinutes: config.dailyHoursCapMinutes,
      streamedSecondsThisWeek,
      timingProgressPercent: Math.min(
        100,
        Math.floor((streamedSecondsThisWeek * 100) / requiredSeconds),
      ),
      timingRequirementMet,
      weeklyEarningsPoints: weeklyEarningsPoints.toString(),
      timing: {
        step1: {
          points: config.timingStep1PointsBigInt.toString(),
          unlocked: step1Unlocked,
          claimed: claimedTypes.has('TIMING_STEP_1'),
        },
        step2: {
          points: config.timingStep2PointsBigInt.toString(),
          unlocked: step2Unlocked,
          claimed: claimedTypes.has('TIMING_STEP_2'),
          earningThreshold: config.timingStep2EarningThresholdBigInt.toString(),
        },
        totalClaimed: timingClaimedTotal.toString(),
      },
      gifting: {
        tiers: gifting,
        totalClaimed: giftingClaimedTotal.toString(),
      },
      totalRewardPointsThisWeek: (timingClaimedTotal + giftingClaimedTotal).toString(),
    }
  },

  async claimReward(
    userId: string,
    rewardType: string,
  ): Promise<{ rewardType: string; pointsAmount: string; claimedAt: string }> {
    const { eligible, config } = await loadStatusInputs(userId)
    if (!eligible) {
      throw new AppError(403, 'Not a Royal Host', 'ROYAL_HOST_NOT_ELIGIBLE')
    }

    const now = new Date()
    const weekStart = utcStartOfWeek(now)
    const weekEnd = addUtcDays(weekStart, 7)
    const dailyCapSeconds = config.dailyHoursCapMinutes * 60
    const requiredSeconds = config.weeklyHoursRequired * 3600

    const [streamedSecondsThisWeek, weeklyEarningsPoints] = await Promise.all([
      streamedSecondsForWeek(userId, weekStart, dailyCapSeconds),
      royalHostRewardRepository.getQualifyingEarningsForRange(userId, weekStart, weekEnd),
    ])
    const timingRequirementMet = streamedSecondsThisWeek >= requiredSeconds

    let pointsAmount: bigint

    if (rewardType === 'TIMING_STEP_1') {
      if (!timingRequirementMet) {
        throw new AppError(
          403,
          `Stream at least ${config.weeklyHoursRequired} hours this week to claim this reward`,
          'ROYAL_HOST_THRESHOLD_NOT_MET',
        )
      }
      pointsAmount = config.timingStep1PointsBigInt
    } else if (rewardType === 'TIMING_STEP_2') {
      if (
        !timingRequirementMet ||
        weeklyEarningsPoints < config.timingStep2EarningThresholdBigInt
      ) {
        throw new AppError(
          403,
          'Timing requirement and minimum weekly earnings must both be met to claim this reward',
          'ROYAL_HOST_THRESHOLD_NOT_MET',
        )
      }
      pointsAmount = config.timingStep2PointsBigInt
    } else {
      const match = /^GIFTING_TIER_(\d+)$/.exec(rewardType)
      if (!match) {
        throw new AppError(400, 'Invalid reward type', 'INVALID_REQUEST')
      }
      const tierIndex = Number(match[1])
      const tiers = config.giftingTiersBigInt
      const tier = tiers[tierIndex - 1]
      if (!tier) {
        throw new AppError(400, 'Invalid reward type', 'INVALID_REQUEST')
      }
      if (weeklyEarningsPoints < tier.threshold) {
        throw new AppError(
          403,
          'Weekly earnings threshold not met for this tier',
          'ROYAL_HOST_THRESHOLD_NOT_MET',
        )
      }
      const prevCumulative = tierIndex > 1 ? tiers[tierIndex - 2]!.cumulativePoints : 0n
      pointsAmount = tier.cumulativePoints - prevCumulative
    }

    const weekStartStr = utcDateString(weekStart)
    const idempotencyKey = `royal-host-reward:${userId}:${weekStartStr}:${rewardType}`

    try {
      await withSerializationRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const existing = await tx.royalHostRewardClaim.findUnique({
              where: { userId_weekStart_rewardType: { userId, weekStart, rewardType } },
            })
            if (existing) {
              throw new AppError(409, 'Already claimed', 'ALREADY_CLAIMED')
            }

            // Royal Host reward points are excluded from livestream XP, wealth/rich
            // tier (never touched by point credits), and agency commission (this
            // tx type is not in point-wallet's commission-eligible set).
            const credit = await pointWalletService.creditInTransaction(
              userId,
              pointsAmount,
              PointTxType.ROYAL_HOST_REWARD,
              tx,
              {
                idempotencyKey,
                description: 'Royal Host weekly reward',
                metadata: { weekStart: weekStartStr, rewardType },
                applyLivestreamLevel: false,
              },
            )

            await royalHostRewardRepository.insertClaim(
              {
                userId,
                weekStart,
                rewardType,
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
      rewardType,
      pointsAmount: pointsAmount.toString(),
      claimedAt: new Date().toISOString(),
    }
  },
}
