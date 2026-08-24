import { redisClient, RedisKeys, LIVESTREAM_REWARD_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_LIVESTREAM_REWARD_POINTS_PER_HOUR,
  DEFAULT_LIVESTREAM_REWARD_WINDOW_DAYS,
  livestreamRewardConfigRepository,
} from '../repositories/livestreamRewardConfig.repository'
import type { LivestreamRewardConfigUpdateInput } from '../models/livestreamRewardConfig.schemas'

const MIN_WINDOW_DAYS = 1
const MAX_WINDOW_DAYS = 30
const MIN_POINTS_PER_HOUR = 1
const MAX_POINTS_PER_HOUR = 1_000_000

/** Part thresholds in streamed minutes (part 1 = 1h, part 2 = 2h). Fixed product rule. */
export const LIVESTREAM_REWARD_PART_THRESHOLDS_MIN: Record<number, number> = { 1: 60, 2: 120 }

export type LivestreamRewardConfigDto = {
  windowDays: number
  pointsPerHour: number
  updatedAt: string
}

export type LivestreamRewardEffectiveConfig = LivestreamRewardConfigDto & {
  pointsPerHourBigInt: bigint
}

function clampWindowDays(n: number): number {
  if (!Number.isFinite(n) || n < MIN_WINDOW_DAYS) return DEFAULT_LIVESTREAM_REWARD_WINDOW_DAYS
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.trunc(n)))
}

function clampPointsPerHour(n: number): number {
  if (!Number.isFinite(n) || n < MIN_POINTS_PER_HOUR) {
    return DEFAULT_LIVESTREAM_REWARD_POINTS_PER_HOUR
  }
  return Math.min(MAX_POINTS_PER_HOUR, Math.max(MIN_POINTS_PER_HOUR, Math.trunc(n)))
}

function serialize(row: {
  windowDays: number
  pointsPerHour: number
  updatedAt: Date
}): LivestreamRewardEffectiveConfig {
  const windowDays = clampWindowDays(row.windowDays)
  const pointsPerHour = clampPointsPerHour(row.pointsPerHour)
  return {
    windowDays,
    pointsPerHour,
    pointsPerHourBigInt: BigInt(pointsPerHour),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const livestreamRewardConfigService = {
  async getConfig(): Promise<LivestreamRewardEffectiveConfig> {
    const key = RedisKeys.livestreamRewardConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as LivestreamRewardConfigDto
        if (
          typeof parsed.windowDays === 'number' &&
          typeof parsed.pointsPerHour === 'number' &&
          parsed.windowDays >= MIN_WINDOW_DAYS &&
          parsed.pointsPerHour >= MIN_POINTS_PER_HOUR
        ) {
          return serialize({
            windowDays: parsed.windowDays,
            pointsPerHour: parsed.pointsPerHour,
            updatedAt: new Date(parsed.updatedAt),
          })
        }
      }
    } catch {
      /* miss */
    }

    const row = await livestreamRewardConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, LIVESTREAM_REWARD_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async bustCache() {
    await redisClient.del(RedisKeys.livestreamRewardConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: LivestreamRewardConfigUpdateInput,
  ): Promise<LivestreamRewardEffectiveConfig> {
    const current = await livestreamRewardConfigService.getConfig()
    const windowDays = clampWindowDays(input.windowDays ?? current.windowDays)
    const pointsPerHour = clampPointsPerHour(input.pointsPerHour ?? current.pointsPerHour)

    if (
      input.windowDays != null &&
      (input.windowDays < MIN_WINDOW_DAYS || input.windowDays > MAX_WINDOW_DAYS)
    ) {
      throw new AppError(
        400,
        `windowDays must be between ${MIN_WINDOW_DAYS} and ${MAX_WINDOW_DAYS}`,
        'INVALID_LIVESTREAM_REWARD_WINDOW',
      )
    }
    if (
      input.pointsPerHour != null &&
      (input.pointsPerHour < MIN_POINTS_PER_HOUR || input.pointsPerHour > MAX_POINTS_PER_HOUR)
    ) {
      throw new AppError(
        400,
        `pointsPerHour must be between ${MIN_POINTS_PER_HOUR} and ${MAX_POINTS_PER_HOUR}`,
        'INVALID_LIVESTREAM_REWARD_POINTS',
      )
    }

    await livestreamRewardConfigRepository.getOrCreate()
    const row = await livestreamRewardConfigRepository.update({
      windowDays,
      pointsPerHour,
      updatedByAdminId: adminUserId,
    })
    await livestreamRewardConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.livestreamRewardConfig(),
        LIVESTREAM_REWARD_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}
