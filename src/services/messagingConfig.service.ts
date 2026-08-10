import { redisClient, RedisKeys, MESSAGING_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_MESSAGE_ACTION_WINDOW_MS,
  messagingConfigRepository,
} from '../repositories/messagingConfig.repository'
import type { MessagingConfigUpdateInput } from '../models/messagingConfig.schemas'

const MIN_WINDOW_MS = 1_000 // 1 second
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export type MessagingActionWindowUnit = 'seconds' | 'minutes' | 'hours'

export type MessagingConfigDto = {
  amount: number
  unit: MessagingActionWindowUnit
  windowMs: number
  /** Whole minutes (rounded); for sub-minute windows may be 0 use windowMs / amount+unit. */
  windowMinutes: number
  /** Whole seconds (floor of windowMs / 1000). */
  windowSeconds: number
  updatedAt: string
}

export function amountUnitToMs(amount: number, unit: MessagingActionWindowUnit): number {
  if (unit === 'hours') return amount * 3_600_000
  if (unit === 'minutes') return amount * 60_000
  return amount * 1_000
}

/**
 * Prefer whole hours when divisible by 1h; else whole minutes when divisible by 1m;
 * otherwise seconds.
 */
export function toDisplayAmountUnit(windowMs: number): {
  amount: number
  unit: MessagingActionWindowUnit
  windowMinutes: number
  windowSeconds: number
} {
  const windowSeconds = Math.max(1, Math.floor(windowMs / 1_000))
  const windowMinutes = Math.floor(windowMs / 60_000)
  if (windowMs % 3_600_000 === 0) {
    return { amount: windowMs / 3_600_000, unit: 'hours', windowMinutes, windowSeconds }
  }
  if (windowMs % 60_000 === 0) {
    return {
      amount: Math.max(1, windowMinutes),
      unit: 'minutes',
      windowMinutes: Math.max(1, windowMinutes),
      windowSeconds,
    }
  }
  return { amount: windowSeconds, unit: 'seconds', windowMinutes, windowSeconds }
}

function serialize(row: { actionWindowMs: number; updatedAt: Date }): MessagingConfigDto {
  const windowMs = row.actionWindowMs > 0 ? row.actionWindowMs : DEFAULT_MESSAGE_ACTION_WINDOW_MS
  const display = toDisplayAmountUnit(windowMs)
  return {
    amount: display.amount,
    unit: display.unit,
    windowMs,
    windowMinutes: display.windowMinutes,
    windowSeconds: display.windowSeconds,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const messagingConfigService = {
  async getConfig(): Promise<MessagingConfigDto> {
    const key = RedisKeys.messagingConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as MessagingConfigDto
        // Older cache payloads may omit windowSeconds — recompute from windowMs.
        if (typeof parsed.windowSeconds !== 'number' && typeof parsed.windowMs === 'number') {
          const display = toDisplayAmountUnit(parsed.windowMs)
          return {
            ...parsed,
            amount: display.amount,
            unit: display.unit,
            windowMinutes: display.windowMinutes,
            windowSeconds: display.windowSeconds,
          }
        }
        return parsed
      }
    } catch {
      /* miss */
    }

    const row = await messagingConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, MESSAGING_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async getActionWindowMs(): Promise<number> {
    const cfg = await messagingConfigService.getConfig()
    return cfg.windowMs > 0 ? cfg.windowMs : DEFAULT_MESSAGE_ACTION_WINDOW_MS
  },

  async bustCache() {
    await redisClient.del(RedisKeys.messagingConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: MessagingConfigUpdateInput,
  ): Promise<MessagingConfigDto> {
    const rawMs = amountUnitToMs(input.amount, input.unit)
    if (rawMs < MIN_WINDOW_MS || rawMs > MAX_WINDOW_MS) {
      throw new AppError(
        400,
        `Action window must be between 1 second and 7 days (got ${input.amount} ${input.unit})`,
        'INVALID_ACTION_WINDOW',
      )
    }

    const row = await messagingConfigRepository.update({
      actionWindowMs: rawMs,
      updatedByUserId: adminUserId,
    })
    await messagingConfigService.bustCache()
    return serialize(row)
  },
}
