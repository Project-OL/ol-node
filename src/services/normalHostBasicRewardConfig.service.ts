import { redisClient, RedisKeys, NORMAL_HOST_BASIC_REWARD_CONFIG_TTL } from '../config/redis'
import { normalHostBasicRewardConfigRepository } from '../repositories/normalHostBasicRewardConfig.repository'
import type { NormalHostBasicRewardConfigUpdateInput } from '../models/normalHostBasicRewardConfig.schemas'

export type NormalHostBasicRewardConfigDto = {
  enabled: boolean
  requiredMinutes: number
  pointsAmount: string
  updatedAt: string
}

export type NormalHostBasicRewardEffectiveConfig = NormalHostBasicRewardConfigDto & {
  pointsAmountBigInt: bigint
}

function serialize(row: {
  enabled: boolean
  requiredMinutes: number
  pointsAmount: bigint | string
  updatedAt: Date
}): NormalHostBasicRewardEffectiveConfig {
  const points = BigInt(row.pointsAmount)
  return {
    enabled: row.enabled,
    requiredMinutes: row.requiredMinutes,
    pointsAmount: points.toString(),
    updatedAt: row.updatedAt.toISOString(),
    pointsAmountBigInt: points,
  }
}

function toDto(cfg: NormalHostBasicRewardEffectiveConfig): NormalHostBasicRewardConfigDto {
  return {
    enabled: cfg.enabled,
    requiredMinutes: cfg.requiredMinutes,
    pointsAmount: cfg.pointsAmount,
    updatedAt: cfg.updatedAt,
  }
}

async function writeCache(cfg: NormalHostBasicRewardEffectiveConfig) {
  try {
    await redisClient.setex(
      RedisKeys.normalHostBasicRewardConfig(),
      NORMAL_HOST_BASIC_REWARD_CONFIG_TTL,
      JSON.stringify(toDto(cfg)),
    )
  } catch {
    /* ignore */
  }
}

export const normalHostBasicRewardConfigService = {
  async getConfig(): Promise<NormalHostBasicRewardEffectiveConfig> {
    try {
      const hit = await redisClient.get(RedisKeys.normalHostBasicRewardConfig())
      if (hit) {
        const parsed = JSON.parse(hit) as NormalHostBasicRewardConfigDto
        return serialize({ ...parsed, updatedAt: new Date(parsed.updatedAt) })
      }
    } catch {
      /* miss */
    }

    const cfg = serialize(await normalHostBasicRewardConfigRepository.getOrCreate())
    await writeCache(cfg)
    return cfg
  },

  /** Admin GET/PUT response: same shape as the cached DTO, no bigint. */
  async getConfigDto(): Promise<NormalHostBasicRewardConfigDto> {
    return toDto(await normalHostBasicRewardConfigService.getConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: NormalHostBasicRewardConfigUpdateInput,
  ): Promise<NormalHostBasicRewardConfigDto> {
    await normalHostBasicRewardConfigRepository.getOrCreate()
    const row = await normalHostBasicRewardConfigRepository.update({
      enabled: input.enabled,
      requiredMinutes: input.requiredMinutes,
      pointsAmount: BigInt(input.pointsAmount),
      updatedByAdminId: adminUserId,
    })
    await redisClient.del(RedisKeys.normalHostBasicRewardConfig())
    const cfg = serialize(row)
    await writeCache(cfg)
    return toDto(cfg)
  },
}
