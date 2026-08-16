import { redisClient, RedisKeys, AGENCY_HOST_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_REJOIN_COOLDOWN_HOURS,
  agencyHostConfigRepository,
} from '../repositories/agencyHostConfig.repository'
import type { AgencyHostConfigUpdateInput } from '../models/agencyHostConfig.schemas'

const MIN_HOURS = 1
const MAX_HOURS = 365 * 24
const HOUR_MS = 60 * 60 * 1000

export type AgencyHostCooldownUnit = 'hours' | 'days'

export type AgencyHostConfigDto = {
  amount: number
  unit: AgencyHostCooldownUnit
  rejoinCooldownHours: number
  rejoinCooldownMs: number
  updatedAt: string
}

function clampHours(n: number): number {
  if (!Number.isFinite(n) || n < MIN_HOURS) return DEFAULT_REJOIN_COOLDOWN_HOURS
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, Math.trunc(n)))
}

function hoursFromInput(input: AgencyHostConfigUpdateInput): number {
  if (input.rejoinCooldownHours != null) {
    return clampHours(input.rejoinCooldownHours)
  }
  const amount = input.amount!
  const unit = input.unit!
  const hours = unit === 'days' ? amount * 24 : amount
  if (hours < MIN_HOURS || hours > MAX_HOURS) {
    throw new AppError(
      400,
      `Rejoin cooldown must be between 1 hour and 365 days (got ${amount} ${unit})`,
      'INVALID_REJOIN_COOLDOWN',
    )
  }
  return hours
}

function serialize(row: { rejoinCooldownHours: number; updatedAt: Date }): AgencyHostConfigDto {
  const hours = clampHours(row.rejoinCooldownHours)
  const useDays = hours >= 24 && hours % 24 === 0
  return {
    amount: useDays ? hours / 24 : hours,
    unit: useDays ? 'days' : 'hours',
    rejoinCooldownHours: hours,
    rejoinCooldownMs: hours * HOUR_MS,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const agencyHostConfigService = {
  async getConfig(): Promise<AgencyHostConfigDto> {
    const key = RedisKeys.agencyHostConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as AgencyHostConfigDto
        if (typeof parsed.rejoinCooldownHours === 'number' && parsed.rejoinCooldownHours > 0) {
          return parsed
        }
      }
    } catch {
      /* miss */
    }

    const row = await agencyHostConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, AGENCY_HOST_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async getRejoinCooldownMs(): Promise<number> {
    try {
      const cfg = await agencyHostConfigService.getConfig()
      return clampHours(cfg.rejoinCooldownHours) * HOUR_MS
    } catch (err) {
      console.warn('[agency-host-config] using 24h rejoin cooldown fallback', err)
      return DEFAULT_REJOIN_COOLDOWN_HOURS * HOUR_MS
    }
  },

  async bustCache() {
    await redisClient.del(RedisKeys.agencyHostConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: AgencyHostConfigUpdateInput,
  ): Promise<AgencyHostConfigDto> {
    await agencyHostConfigRepository.getOrCreate()
    const hours = hoursFromInput(input)
    const row = await agencyHostConfigRepository.update({
      rejoinCooldownHours: hours,
      updatedByAdminId: adminUserId,
    })
    await agencyHostConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.agencyHostConfig(),
        AGENCY_HOST_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}
