import { redisClient, RedisKeys, ADMIN_AUTH_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_ADMIN_LOCKOUT_MINUTES,
  DEFAULT_ADMIN_LOCKOUT_THRESHOLD,
  adminAuthConfigRepository,
} from '../repositories/adminAuthConfig.repository'
import type { AdminAuthConfigUpdateInput } from '../models/adminAuthConfig.schemas'
import {
  amountUnitToMs,
  toDisplayAmountUnit,
  type MessagingActionWindowUnit,
} from './messagingConfig.service'

const MIN_LOCKOUT_MINUTES = 1
const MAX_LOCKOUT_MINUTES = 30 * 24 * 60

export type AdminAuthConfigDto = {
  failedLoginThreshold: number
  amount: number
  unit: Exclude<MessagingActionWindowUnit, 'seconds'>
  lockoutMinutes: number
  lockoutMs: number
  updatedAt: string
}

export type AdminLockoutSettings = {
  failedLoginThreshold: number
  lockoutMinutes: number
}

function clampThreshold(n: number): number {
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ADMIN_LOCKOUT_THRESHOLD
  return Math.min(50, Math.max(1, Math.trunc(n)))
}

function clampMinutes(n: number): number {
  if (!Number.isFinite(n) || n < MIN_LOCKOUT_MINUTES) return DEFAULT_ADMIN_LOCKOUT_MINUTES
  return Math.min(MAX_LOCKOUT_MINUTES, Math.max(MIN_LOCKOUT_MINUTES, Math.trunc(n)))
}

function serialize(row: {
  failedLoginThreshold: number
  lockoutMinutes: number
  updatedAt: Date
}): AdminAuthConfigDto {
  const lockoutMinutes = clampMinutes(row.lockoutMinutes)
  const lockoutMs = lockoutMinutes * 60_000
  const display = toDisplayAmountUnit(lockoutMs)
  const unit: AdminAuthConfigDto['unit'] = display.unit === 'seconds' ? 'minutes' : display.unit
  const amount = display.unit === 'seconds' ? Math.max(1, display.windowMinutes) : display.amount
  return {
    failedLoginThreshold: clampThreshold(row.failedLoginThreshold),
    amount,
    unit,
    lockoutMinutes,
    lockoutMs,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const adminAuthConfigService = {
  async getConfig(): Promise<AdminAuthConfigDto> {
    const key = RedisKeys.adminAuthConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as AdminAuthConfigDto
        if (
          typeof parsed.failedLoginThreshold === 'number' &&
          typeof parsed.lockoutMinutes === 'number'
        ) {
          return parsed
        }
      }
    } catch {
      /* miss */
    }

    const row = await adminAuthConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, ADMIN_AUTH_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  /** Login path: Redis/DB with hardcoded fallback so a config miss never blocks auth. */
  async getLockoutSettings(): Promise<AdminLockoutSettings> {
    try {
      const cfg = await adminAuthConfigService.getConfig()
      return {
        failedLoginThreshold: clampThreshold(cfg.failedLoginThreshold),
        lockoutMinutes: clampMinutes(cfg.lockoutMinutes),
      }
    } catch (err) {
      console.warn('[admin-auth-config] using lockout fallbacks', err)
      return {
        failedLoginThreshold: DEFAULT_ADMIN_LOCKOUT_THRESHOLD,
        lockoutMinutes: DEFAULT_ADMIN_LOCKOUT_MINUTES,
      }
    }
  },

  async bustCache() {
    await redisClient.del(RedisKeys.adminAuthConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: AdminAuthConfigUpdateInput,
  ): Promise<AdminAuthConfigDto> {
    await adminAuthConfigRepository.getOrCreate()

    const data: {
      failedLoginThreshold?: number
      lockoutMinutes?: number
      updatedByUserId: string
    } = { updatedByUserId: adminUserId }

    if (input.failedLoginThreshold !== undefined) {
      data.failedLoginThreshold = clampThreshold(input.failedLoginThreshold)
    }

    if (input.amount !== undefined && input.unit !== undefined) {
      const rawMs = amountUnitToMs(input.amount, input.unit)
      const minutes = Math.round(rawMs / 60_000)
      if (minutes < MIN_LOCKOUT_MINUTES || minutes > MAX_LOCKOUT_MINUTES) {
        throw new AppError(
          400,
          `Lock duration must be between 1 minute and 30 days (got ${input.amount} ${input.unit})`,
          'INVALID_ADMIN_LOCKOUT_WINDOW',
        )
      }
      data.lockoutMinutes = minutes
    }

    const row = await adminAuthConfigRepository.update(data)
    await adminAuthConfigService.bustCache()
    const dto = serialize(row)
    try {
      await redisClient.setex(
        RedisKeys.adminAuthConfig(),
        ADMIN_AUTH_CONFIG_TTL,
        JSON.stringify(dto),
      )
    } catch {
      /* ignore */
    }
    return dto
  },
}
