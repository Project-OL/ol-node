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

export const ROYAL_HOST_TAG = 'royal host'

export type RoyalHostTimingClaimType = 'TIMING_STEP_1' | 'TIMING_STEP_2'

export type RoyalHostCurrentTimingDto = {
  claimType: RoyalHostTimingClaimType
  points: string
  requiredMinutes: number
  completedMinutes: number
  earningThreshold: string | null
  earnedPoints: string | null
  remainingPoints: string | null
  progressPercent: number
  unlocked: boolean
  claimed: boolean
}

export type RoyalHostNextTimingDto = {
  claimType: RoyalHostTimingClaimType
  points: string
  earningThreshold: string | null
}

export type RoyalHostCurrentGiftingDto = {
  claimType: string
  threshold: string
  points: string
  earnedPoints: string
  remainingPoints: string
  progressPercent: number
  unlocked: boolean
  claimed: boolean
}

export type RoyalHostNextGiftingDto = {
  claimType: string
  threshold: string
  points: string
}

export type RoyalHostTierRewardDto = {
  threshold: string
  totalReward: string
}

export type RoyalHostRewardStatusDto =
  | { eligible: false }
  | {
      eligible: true
      weekStart: string
      weekEndsInSeconds: number
      dailyHoursCapMinutes: number
      weeklyEarningsPoints: string
      timingReward: {
        totalClaimed: string
        current: RoyalHostCurrentTimingDto | null
        next: RoyalHostNextTimingDto | null
      }
      giftingReward: {
        totalClaimed: string
        current: RoyalHostCurrentGiftingDto | null
        next: RoyalHostNextGiftingDto | null
      }
      /** Full reference ladder: threshold reached -> total cumulative reward for the week. */
      tiers: RoyalHostTierRewardDto[]
      totalRewardPointsThisWeek: string
    }

export function hasRoyalHostTag(adminTags: string[]): boolean {
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

type GiftingTierComputed = {
  claimType: string
  threshold: bigint
  incrementPoints: bigint
  cumulativePoints: bigint
  unlocked: boolean
  claimed: boolean
}

function computeGiftingTiers(
  config: RoyalHostRewardEffectiveConfig,
  weeklyEarnings: bigint,
  claimedTypes: Set<string>,
): GiftingTierComputed[] {
  let prevCumulative = 0n
  return config.giftingTiersBigInt.map((tier, i) => {
    const tierIndex = i + 1
    const claimType = `GIFTING_TIER_${tierIndex}`
    const incrementPoints = tier.cumulativePoints - prevCumulative
    const computed: GiftingTierComputed = {
      claimType,
      threshold: tier.threshold,
      incrementPoints,
      cumulativePoints: tier.cumulativePoints,
      unlocked: weeklyEarnings >= tier.threshold,
      claimed: claimedTypes.has(claimType),
    }
    prevCumulative = tier.cumulativePoints
    return computed
  })
}

function giftingProgress(
  tier: GiftingTierComputed,
  weeklyEarnings: bigint,
): { earnedPoints: string; remainingPoints: string; progressPercent: number } {
  const remaining = tier.unlocked ? 0n : tier.threshold - weeklyEarnings
  const progressPercent = tier.unlocked
    ? 100
    : tier.threshold > 0n
      ? Math.min(100, Number((weeklyEarnings * 100n) / tier.threshold))
      : 0
  return {
    earnedPoints: weeklyEarnings.toString(),
    remainingPoints: remaining.toString(),
    progressPercent,
  }
}

/**
 * Walk tiers in order; "current" = first not-yet-claimed one (locked+in-progress, or unlocked+claimable).
 * "next" previews the tier that becomes current once `current` is claimed — but while `current` is still
 * LOCKED, there's nothing to unlock beyond it yet, so `next` mirrors `current`'s own tier instead of
 * skipping ahead (avoids showing a milestone the user can't work toward before clearing the one in front of it).
 */
function buildGiftingCurrentAndNext(
  tiers: GiftingTierComputed[],
  weeklyEarnings: bigint,
): { current: RoyalHostCurrentGiftingDto | null; next: RoyalHostNextGiftingDto | null } {
  const currentIndex = tiers.findIndex((t) => !t.claimed)
  if (currentIndex === -1) return { current: null, next: null }

  const tier = tiers[currentIndex]!
  const progress = giftingProgress(tier, weeklyEarnings)
  const current: RoyalHostCurrentGiftingDto = {
    claimType: tier.claimType,
    threshold: tier.threshold.toString(),
    points: tier.incrementPoints.toString(),
    ...progress,
    unlocked: tier.unlocked,
    claimed: tier.claimed,
  }

  const nextTier = tier.unlocked ? tiers[currentIndex + 1] : tier
  const next: RoyalHostNextGiftingDto | null = nextTier
    ? {
        claimType: nextTier.claimType,
        threshold: nextTier.threshold.toString(),
        points: nextTier.incrementPoints.toString(),
      }
    : null

  return { current, next }
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
    const step1Claimed = claimedTypes.has('TIMING_STEP_1')
    const step2Claimed = claimedTypes.has('TIMING_STEP_2')

    const timingClaimedTotal =
      (step1Claimed ? config.timingStep1PointsBigInt : 0n) +
      (step2Claimed ? config.timingStep2PointsBigInt : 0n)

    const requiredMinutes = Math.floor(requiredSeconds / 60)
    const completedMinutes = Math.min(requiredMinutes, Math.floor(streamedSecondsThisWeek / 60))

    let timingCurrent: RoyalHostCurrentTimingDto | null = null
    let timingNext: RoyalHostNextTimingDto | null = null
    if (!step1Claimed) {
      timingCurrent = {
        claimType: 'TIMING_STEP_1',
        points: config.timingStep1PointsBigInt.toString(),
        requiredMinutes,
        completedMinutes,
        earningThreshold: null,
        earnedPoints: null,
        remainingPoints: null,
        progressPercent:
          requiredMinutes > 0
            ? Math.min(100, Math.floor((completedMinutes * 100) / requiredMinutes))
            : 0,
        unlocked: step1Unlocked,
        claimed: step1Claimed,
      }
      // While step 1 is still locked, there's nothing to unlock beyond it yet — mirror step 1
      // itself instead of previewing step 2 (see buildGiftingCurrentAndNext for the same rule).
      timingNext = step1Unlocked
        ? {
            claimType: 'TIMING_STEP_2',
            points: config.timingStep2PointsBigInt.toString(),
            earningThreshold: config.timingStep2EarningThresholdBigInt.toString(),
          }
        : {
            claimType: 'TIMING_STEP_1',
            points: config.timingStep1PointsBigInt.toString(),
            earningThreshold: null,
          }
    } else if (!step2Claimed) {
      const threshold = config.timingStep2EarningThresholdBigInt
      const remaining = weeklyEarningsPoints >= threshold ? 0n : threshold - weeklyEarningsPoints
      timingCurrent = {
        claimType: 'TIMING_STEP_2',
        points: config.timingStep2PointsBigInt.toString(),
        requiredMinutes,
        completedMinutes,
        earningThreshold: threshold.toString(),
        earnedPoints: weeklyEarningsPoints.toString(),
        remainingPoints: remaining.toString(),
        progressPercent:
          threshold > 0n ? Math.min(100, Number((weeklyEarningsPoints * 100n) / threshold)) : 100,
        unlocked: step2Unlocked,
        claimed: step2Claimed,
      }
      // Step 2 is the last step — once it's unlocked there's genuinely nothing after it (next stays
      // null), but while it's still locked, mirror it the same way step 1's locked case does above.
      timingNext = step2Unlocked
        ? null
        : {
            claimType: 'TIMING_STEP_2',
            points: config.timingStep2PointsBigInt.toString(),
            earningThreshold: threshold.toString(),
          }
    }

    const giftingTiersComputed = computeGiftingTiers(config, weeklyEarningsPoints, claimedTypes)
    const { current: giftingCurrent, next: giftingNext } = buildGiftingCurrentAndNext(
      giftingTiersComputed,
      weeklyEarningsPoints,
    )
    const giftingClaimedTotal = claims
      .filter((c) => c.rewardType.startsWith('GIFTING_TIER_'))
      .reduce((sum, c) => sum + c.pointsAmount, 0n)

    const tiers: RoyalHostTierRewardDto[] = giftingTiersComputed.map((t) => ({
      threshold: t.threshold.toString(),
      totalReward: t.cumulativePoints.toString(),
    }))

    return {
      eligible: true,
      weekStart: utcDateString(weekStart),
      weekEndsInSeconds: Math.max(0, Math.floor((weekEnd.getTime() - now.getTime()) / 1000)),
      dailyHoursCapMinutes: config.dailyHoursCapMinutes,
      weeklyEarningsPoints: weeklyEarningsPoints.toString(),
      timingReward: {
        totalClaimed: timingClaimedTotal.toString(),
        current: timingCurrent,
        next: timingNext,
      },
      giftingReward: {
        totalClaimed: giftingClaimedTotal.toString(),
        current: giftingCurrent,
        next: giftingNext,
      },
      tiers,
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
