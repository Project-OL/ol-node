import { redisClient, RedisKeys, NORMAL_HOST_REWARD_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  normalHostRewardConfigRepository,
  DEFAULT_NORMAL_HOST_REWARD_TIERS,
} from '../repositories/normalHostRewardConfig.repository'
import type { NormalHostRewardConfigUpdateInput } from '../models/normalHostRewardConfig.schemas'

export type NormalHostTierDto = {
  thresholdPoints: string
  hourlyRatePoints: string
  hourCapHours: number
  windowDays: number
}

export type NormalHostRewardConfigDto = {
  tiers: NormalHostTierDto[]
  updatedAt: string
}

export type NormalHostTierBigInt = {
  thresholdPoints: bigint
  hourlyRatePoints: bigint
  hourCapHours: number
  windowDays: number
}

export type NormalHostRewardEffectiveConfig = NormalHostRewardConfigDto & {
  tiersBigInt: NormalHostTierBigInt[]
}

function parseTiers(raw: unknown): NormalHostTierDto[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_NORMAL_HOST_REWARD_TIERS
  const tiers = raw
    .filter(
      (t): t is NormalHostTierDto =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as NormalHostTierDto).thresholdPoints === 'string' &&
        typeof (t as NormalHostTierDto).hourlyRatePoints === 'string' &&
        typeof (t as NormalHostTierDto).hourCapHours === 'number' &&
        typeof (t as NormalHostTierDto).windowDays === 'number',
    )
    .map((t) => ({
      thresholdPoints: t.thresholdPoints,
      hourlyRatePoints: t.hourlyRatePoints,
      hourCapHours: t.hourCapHours,
      windowDays: t.windowDays,
    }))
  return tiers.length > 0 ? tiers : DEFAULT_NORMAL_HOST_REWARD_TIERS
}

/** Strictly ascending thresholds (rates/caps/windows are independently admin-set, no formula enforced). */
function validateTiers(tiers: { thresholdPoints: string; hourlyRatePoints: string }[]): void {
  let prevThreshold = -1n
  for (const t of tiers) {
    const threshold = BigInt(t.thresholdPoints)
    const rate = BigInt(t.hourlyRatePoints)
    if (threshold <= prevThreshold) {
      throw new AppError(
        400,
        'tiers thresholdPoints must be strictly ascending',
        'INVALID_NORMAL_HOST_TIERS',
      )
    }
    if (rate <= 0n) {
      throw new AppError(
        400,
        'tiers hourlyRatePoints must be positive',
        'INVALID_NORMAL_HOST_TIERS',
      )
    }
    prevThreshold = threshold
  }
}

function serialize(row: { tiers: unknown; updatedAt: Date }): NormalHostRewardEffectiveConfig {
  const tiers = parseTiers(row.tiers)
  return {
    tiers,
    updatedAt: row.updatedAt.toISOString(),
    tiersBigInt: tiers.map((t) => ({
      thresholdPoints: BigInt(t.thresholdPoints),
      hourlyRatePoints: BigInt(t.hourlyRatePoints),
      hourCapHours: t.hourCapHours,
      windowDays: t.windowDays,
    })),
  }
}

export const normalHostRewardConfigService = {
  async getConfig(): Promise<NormalHostRewardEffectiveConfig> {
    const key = RedisKeys.normalHostRewardConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as NormalHostRewardConfigDto
        return serialize({ tiers: parsed.tiers, updatedAt: new Date(parsed.updatedAt) })
      }
    } catch {
      /* miss */
    }

    const row = await normalHostRewardConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, NORMAL_HOST_REWARD_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async bustCache() {
    await redisClient.del(RedisKeys.normalHostRewardConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: NormalHostRewardConfigUpdateInput,
  ): Promise<NormalHostRewardEffectiveConfig> {
    validateTiers(input.tiers)

    await normalHostRewardConfigRepository.getOrCreate()
    const row = await normalHostRewardConfigRepository.update({
      tiers: input.tiers,
      updatedByAdminId: adminUserId,
    })
    await normalHostRewardConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.normalHostRewardConfig(),
        NORMAL_HOST_REWARD_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}
