import { redisClient, RedisKeys, ACCOUNT_DELETION_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_DELETION_PERIOD_DAYS,
  DEFAULT_GRACE_PERIOD_DAYS,
  accountDeletionConfigRepository,
} from '../repositories/accountDeletionConfig.repository'
import type { AccountDeletionConfigUpdateInput } from '../models/accountDeletionConfig.schemas'

const MIN_DAYS = 1
const MAX_DAYS = 365

export type AccountDeletionConfigDto = {
  gracePeriodDays: number
  deletionPeriodDays: number
  updatedAt: string
}

function clampDays(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n < MIN_DAYS) return fallback
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.trunc(n)))
}

function serialize(row: {
  gracePeriodDays: number
  deletionPeriodDays: number
  updatedAt: Date
}): AccountDeletionConfigDto {
  const gracePeriodDays = clampDays(row.gracePeriodDays, DEFAULT_GRACE_PERIOD_DAYS)
  const deletionPeriodDays = clampDays(row.deletionPeriodDays, DEFAULT_DELETION_PERIOD_DAYS)
  return {
    gracePeriodDays,
    deletionPeriodDays: Math.max(deletionPeriodDays, gracePeriodDays),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const accountDeletionConfigService = {
  async getConfig(): Promise<AccountDeletionConfigDto> {
    const key = RedisKeys.accountDeletionConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as AccountDeletionConfigDto
        if (
          typeof parsed.gracePeriodDays === 'number' &&
          typeof parsed.deletionPeriodDays === 'number' &&
          parsed.gracePeriodDays >= MIN_DAYS &&
          parsed.deletionPeriodDays >= parsed.gracePeriodDays
        ) {
          return parsed
        }
      }
    } catch {
      /* miss */
    }

    const row = await accountDeletionConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, ACCOUNT_DELETION_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async getPeriods(): Promise<{ gracePeriodDays: number; deletionPeriodDays: number }> {
    try {
      const cfg = await accountDeletionConfigService.getConfig()
      return {
        gracePeriodDays: cfg.gracePeriodDays,
        deletionPeriodDays: cfg.deletionPeriodDays,
      }
    } catch (err) {
      console.warn('[account-deletion-config] using 30/45 day fallback', err)
      return {
        gracePeriodDays: DEFAULT_GRACE_PERIOD_DAYS,
        deletionPeriodDays: DEFAULT_DELETION_PERIOD_DAYS,
      }
    }
  },

  async bustCache() {
    await redisClient.del(RedisKeys.accountDeletionConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: AccountDeletionConfigUpdateInput,
  ): Promise<AccountDeletionConfigDto> {
    const current = await accountDeletionConfigService.getConfig()
    const gracePeriodDays = clampDays(
      input.gracePeriodDays ?? current.gracePeriodDays,
      DEFAULT_GRACE_PERIOD_DAYS,
    )
    const deletionPeriodDays = clampDays(
      input.deletionPeriodDays ?? current.deletionPeriodDays,
      DEFAULT_DELETION_PERIOD_DAYS,
    )
    if (deletionPeriodDays < gracePeriodDays) {
      throw new AppError(
        400,
        `deletionPeriodDays (${deletionPeriodDays}) must be greater than or equal to gracePeriodDays (${gracePeriodDays})`,
        'INVALID_DELETION_PERIOD',
      )
    }

    await accountDeletionConfigRepository.getOrCreate()
    const row = await accountDeletionConfigRepository.update({
      gracePeriodDays,
      deletionPeriodDays,
      updatedByUserId: adminUserId,
    })
    await accountDeletionConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.accountDeletionConfig(),
        ACCOUNT_DELETION_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}
