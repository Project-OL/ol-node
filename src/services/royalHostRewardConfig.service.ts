import { redisClient, RedisKeys, ROYAL_HOST_REWARD_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  royalHostRewardConfigRepository,
  DEFAULT_ROYAL_HOST_WEEKLY_HOURS_REQUIRED,
  DEFAULT_ROYAL_HOST_DAILY_HOURS_CAP_MINUTES,
  DEFAULT_ROYAL_HOST_TIMING_STEP1_POINTS,
  DEFAULT_ROYAL_HOST_TIMING_STEP2_POINTS,
  DEFAULT_ROYAL_HOST_TIMING_STEP2_EARNING_THRESHOLD,
  DEFAULT_ROYAL_HOST_GIFTING_TIERS,
  DEFAULT_ROYAL_HOST_CONSECUTIVE_MISS_WEEKS_LIMIT,
  DEFAULT_ROYAL_HOST_AUTO_REVOKE_EARNING_THRESHOLD,
} from '../repositories/royalHostRewardConfig.repository'
import type {
  RoyalHostRewardConfigUpdateInput,
  RoyalHostGiftingTierInput,
} from '../models/royalHostRewardConfig.schemas'

const MIN_WEEKLY_HOURS = 1
const MAX_WEEKLY_HOURS = 168
const MIN_DAILY_CAP_MINUTES = 1
const MAX_DAILY_CAP_MINUTES = 1440
const MIN_MISS_WEEKS_LIMIT = 1
const MAX_MISS_WEEKS_LIMIT = 52

export type RoyalHostGiftingTierDto = {
  threshold: string
  cumulativePoints: string
}

export type RoyalHostRewardConfigDto = {
  weeklyHoursRequired: number
  dailyHoursCapMinutes: number
  timingStep1Points: string
  timingStep2Points: string
  timingStep2EarningThreshold: string
  giftingTiers: RoyalHostGiftingTierDto[]
  consecutiveMissWeeksLimit: number
  autoRevokeEarningThreshold: string
  updatedAt: string
}

export type RoyalHostRewardEffectiveConfig = RoyalHostRewardConfigDto & {
  timingStep1PointsBigInt: bigint
  timingStep2PointsBigInt: bigint
  timingStep2EarningThresholdBigInt: bigint
  autoRevokeEarningThresholdBigInt: bigint
  giftingTiersBigInt: { threshold: bigint; cumulativePoints: bigint }[]
}

function parseGiftingTiers(raw: unknown): RoyalHostGiftingTierDto[] {
  if (!Array.isArray(raw)) return DEFAULT_ROYAL_HOST_GIFTING_TIERS
  const tiers = raw
    .filter(
      (t): t is RoyalHostGiftingTierDto =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as RoyalHostGiftingTierDto).threshold === 'string' &&
        typeof (t as RoyalHostGiftingTierDto).cumulativePoints === 'string',
    )
    .map((t) => ({ threshold: t.threshold, cumulativePoints: t.cumulativePoints }))
  return tiers.length > 0 ? tiers : DEFAULT_ROYAL_HOST_GIFTING_TIERS
}

/** Ascending thresholds, non-decreasing cumulative points. */
function validateGiftingTiers(tiers: RoyalHostGiftingTierInput[]): void {
  let prevThreshold = -1n
  let prevCumulative = -1n
  for (const t of tiers) {
    const threshold = BigInt(t.threshold)
    const cumulativePoints = BigInt(t.cumulativePoints)
    if (threshold <= prevThreshold) {
      throw new AppError(
        400,
        'giftingTiers thresholds must be strictly ascending',
        'INVALID_ROYAL_HOST_GIFTING_TIERS',
      )
    }
    if (cumulativePoints < prevCumulative) {
      throw new AppError(
        400,
        'giftingTiers cumulativePoints must be non-decreasing',
        'INVALID_ROYAL_HOST_GIFTING_TIERS',
      )
    }
    prevThreshold = threshold
    prevCumulative = cumulativePoints
  }
}

function serialize(row: {
  weeklyHoursRequired: number
  dailyHoursCapMinutes: number
  timingStep1Points: bigint
  timingStep2Points: bigint
  timingStep2EarningThreshold: bigint
  giftingTiers: unknown
  consecutiveMissWeeksLimit: number
  autoRevokeEarningThreshold: bigint
  updatedAt: Date
}): RoyalHostRewardEffectiveConfig {
  const giftingTiers = parseGiftingTiers(row.giftingTiers)
  return {
    weeklyHoursRequired: row.weeklyHoursRequired,
    dailyHoursCapMinutes: row.dailyHoursCapMinutes,
    timingStep1Points: row.timingStep1Points.toString(),
    timingStep2Points: row.timingStep2Points.toString(),
    timingStep2EarningThreshold: row.timingStep2EarningThreshold.toString(),
    giftingTiers,
    consecutiveMissWeeksLimit: row.consecutiveMissWeeksLimit,
    autoRevokeEarningThreshold: row.autoRevokeEarningThreshold.toString(),
    updatedAt: row.updatedAt.toISOString(),
    timingStep1PointsBigInt: row.timingStep1Points,
    timingStep2PointsBigInt: row.timingStep2Points,
    timingStep2EarningThresholdBigInt: row.timingStep2EarningThreshold,
    autoRevokeEarningThresholdBigInt: row.autoRevokeEarningThreshold,
    giftingTiersBigInt: giftingTiers.map((t) => ({
      threshold: BigInt(t.threshold),
      cumulativePoints: BigInt(t.cumulativePoints),
    })),
  }
}

export const royalHostRewardConfigService = {
  async getConfig(): Promise<RoyalHostRewardEffectiveConfig> {
    const key = RedisKeys.royalHostRewardConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as RoyalHostRewardConfigDto
        return serialize({
          weeklyHoursRequired: parsed.weeklyHoursRequired,
          dailyHoursCapMinutes: parsed.dailyHoursCapMinutes,
          timingStep1Points: BigInt(parsed.timingStep1Points),
          timingStep2Points: BigInt(parsed.timingStep2Points),
          timingStep2EarningThreshold: BigInt(parsed.timingStep2EarningThreshold),
          giftingTiers: parsed.giftingTiers,
          consecutiveMissWeeksLimit: parsed.consecutiveMissWeeksLimit,
          autoRevokeEarningThreshold: BigInt(parsed.autoRevokeEarningThreshold),
          updatedAt: new Date(parsed.updatedAt),
        })
      }
    } catch {
      /* miss */
    }

    const row = await royalHostRewardConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, ROYAL_HOST_REWARD_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async bustCache() {
    await redisClient.del(RedisKeys.royalHostRewardConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: RoyalHostRewardConfigUpdateInput,
  ): Promise<RoyalHostRewardEffectiveConfig> {
    const current = await royalHostRewardConfigService.getConfig()

    if (
      input.weeklyHoursRequired != null &&
      (input.weeklyHoursRequired < MIN_WEEKLY_HOURS || input.weeklyHoursRequired > MAX_WEEKLY_HOURS)
    ) {
      throw new AppError(
        400,
        `weeklyHoursRequired must be between ${MIN_WEEKLY_HOURS} and ${MAX_WEEKLY_HOURS}`,
        'INVALID_ROYAL_HOST_CONFIG',
      )
    }
    if (
      input.dailyHoursCapMinutes != null &&
      (input.dailyHoursCapMinutes < MIN_DAILY_CAP_MINUTES ||
        input.dailyHoursCapMinutes > MAX_DAILY_CAP_MINUTES)
    ) {
      throw new AppError(
        400,
        `dailyHoursCapMinutes must be between ${MIN_DAILY_CAP_MINUTES} and ${MAX_DAILY_CAP_MINUTES}`,
        'INVALID_ROYAL_HOST_CONFIG',
      )
    }
    if (
      input.consecutiveMissWeeksLimit != null &&
      (input.consecutiveMissWeeksLimit < MIN_MISS_WEEKS_LIMIT ||
        input.consecutiveMissWeeksLimit > MAX_MISS_WEEKS_LIMIT)
    ) {
      throw new AppError(
        400,
        `consecutiveMissWeeksLimit must be between ${MIN_MISS_WEEKS_LIMIT} and ${MAX_MISS_WEEKS_LIMIT}`,
        'INVALID_ROYAL_HOST_CONFIG',
      )
    }
    if (input.giftingTiers) {
      validateGiftingTiers(input.giftingTiers)
    }

    await royalHostRewardConfigRepository.getOrCreate()
    const row = await royalHostRewardConfigRepository.update({
      weeklyHoursRequired: input.weeklyHoursRequired ?? current.weeklyHoursRequired,
      dailyHoursCapMinutes: input.dailyHoursCapMinutes ?? current.dailyHoursCapMinutes,
      timingStep1Points: input.timingStep1Points
        ? BigInt(input.timingStep1Points)
        : current.timingStep1PointsBigInt,
      timingStep2Points: input.timingStep2Points
        ? BigInt(input.timingStep2Points)
        : current.timingStep2PointsBigInt,
      timingStep2EarningThreshold: input.timingStep2EarningThreshold
        ? BigInt(input.timingStep2EarningThreshold)
        : current.timingStep2EarningThresholdBigInt,
      giftingTiers: input.giftingTiers ?? current.giftingTiers,
      consecutiveMissWeeksLimit:
        input.consecutiveMissWeeksLimit ?? current.consecutiveMissWeeksLimit,
      autoRevokeEarningThreshold: input.autoRevokeEarningThreshold
        ? BigInt(input.autoRevokeEarningThreshold)
        : current.autoRevokeEarningThresholdBigInt,
      updatedByAdminId: adminUserId,
    })
    await royalHostRewardConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.royalHostRewardConfig(),
        ROYAL_HOST_REWARD_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}

export {
  DEFAULT_ROYAL_HOST_WEEKLY_HOURS_REQUIRED,
  DEFAULT_ROYAL_HOST_DAILY_HOURS_CAP_MINUTES,
  DEFAULT_ROYAL_HOST_TIMING_STEP1_POINTS,
  DEFAULT_ROYAL_HOST_TIMING_STEP2_POINTS,
  DEFAULT_ROYAL_HOST_TIMING_STEP2_EARNING_THRESHOLD,
  DEFAULT_ROYAL_HOST_CONSECUTIVE_MISS_WEEKS_LIMIT,
  DEFAULT_ROYAL_HOST_AUTO_REVOKE_EARNING_THRESHOLD,
}
