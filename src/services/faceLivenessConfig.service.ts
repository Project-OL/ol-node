import { env } from '../config/env'
import { redisClient, RedisKeys, FACE_LIVENESS_CONFIG_TTL } from '../config/redis'
import { faceLivenessConfigRepository } from '../repositories/faceLivenessConfig.repository'
import type { FaceLivenessConfigUpdateInput } from '../models/faceLivenessConfig.schemas'

export type FaceLivenessConfigDto = {
  livenessRequired: boolean
  credentialsRequired: boolean
  /** True when FACE_LIVENESS_STS_ROLE_ARN is set (needed when credentialsRequired). */
  stsRoleConfigured: boolean
  /** Env seed values used only when the singleton row is first created. */
  envDefaults: {
    livenessRequired: boolean
    credentialsRequired: boolean
  }
  updatedAt: string
}

function serialize(row: {
  livenessRequired: boolean
  credentialsRequired: boolean
  updatedAt: Date
}): FaceLivenessConfigDto {
  return {
    livenessRequired: row.livenessRequired,
    credentialsRequired: row.credentialsRequired,
    stsRoleConfigured: Boolean(env.FACE_LIVENESS_STS_ROLE_ARN?.trim()),
    envDefaults: {
      livenessRequired: env.FACE_LIVENESS_REQUIRED,
      credentialsRequired: env.FACE_LIVENESS_CREDENTIALS_REQUIRED,
    },
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const faceLivenessConfigService = {
  async getConfig(): Promise<FaceLivenessConfigDto> {
    const key = RedisKeys.faceLivenessConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as FaceLivenessConfigDto
        // Keep stsRoleConfigured fresh from env (not cached across restarts incorrectly).
        return {
          ...parsed,
          stsRoleConfigured: Boolean(env.FACE_LIVENESS_STS_ROLE_ARN?.trim()),
          envDefaults: {
            livenessRequired: env.FACE_LIVENESS_REQUIRED,
            credentialsRequired: env.FACE_LIVENESS_CREDENTIALS_REQUIRED,
          },
        }
      }
    } catch {
      /* miss */
    }

    const row = await faceLivenessConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, FACE_LIVENESS_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async isLivenessRequired(): Promise<boolean> {
    const cfg = await faceLivenessConfigService.getConfig()
    return cfg.livenessRequired
  },

  async isCredentialsRequired(): Promise<boolean> {
    const cfg = await faceLivenessConfigService.getConfig()
    return cfg.credentialsRequired
  },

  async bustCache() {
    await redisClient.del(RedisKeys.faceLivenessConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: FaceLivenessConfigUpdateInput,
  ): Promise<FaceLivenessConfigDto> {
    await faceLivenessConfigRepository.getOrCreate()
    const row = await faceLivenessConfigRepository.update({
      ...(input.livenessRequired !== undefined ? { livenessRequired: input.livenessRequired } : {}),
      ...(input.credentialsRequired !== undefined
        ? { credentialsRequired: input.credentialsRequired }
        : {}),
      updatedByUserId: adminUserId,
    })
    await faceLivenessConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.faceLivenessConfig(),
        FACE_LIVENESS_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}
