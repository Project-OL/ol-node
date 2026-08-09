import { redisClient, RedisKeys, MESSAGING_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_MESSAGE_ACTION_WINDOW_MS,
  messagingConfigRepository,
} from '../repositories/messagingConfig.repository'
import type { MessagingConfigUpdateInput } from '../models/messagingConfig.schemas'

const MIN_WINDOW_MS = 60_000
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export type MessagingConfigDto = {
  amount: number
  unit: 'minutes' | 'hours'
  windowMs: number
  windowMinutes: number
  updatedAt: string
}

export function amountUnitToMs(amount: number, unit: 'minutes' | 'hours'): number {
  const ms = unit === 'hours' ? amount * 3_600_000 : amount * 60_000
  return ms
}

/** Prefer whole hours when divisible by 1h; otherwise minutes. */
export function toDisplayAmountUnit(windowMs: number): {
  amount: number
  unit: 'minutes' | 'hours'
  windowMinutes: number
} {
  const windowMinutes = Math.max(1, Math.round(windowMs / 60_000))
  if (windowMs % 3_600_000 === 0) {
    return { amount: windowMs / 3_600_000, unit: 'hours', windowMinutes }
  }
  return { amount: windowMinutes, unit: 'minutes', windowMinutes }
}

function serialize(row: { actionWindowMs: number; updatedAt: Date }): MessagingConfigDto {
  const windowMs = row.actionWindowMs > 0 ? row.actionWindowMs : DEFAULT_MESSAGE_ACTION_WINDOW_MS
  const display = toDisplayAmountUnit(windowMs)
  return {
    amount: display.amount,
    unit: display.unit,
    windowMs,
    windowMinutes: display.windowMinutes,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const messagingConfigService = {
  async getConfig(): Promise<MessagingConfigDto> {
    const key = RedisKeys.messagingConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as MessagingConfigDto
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
        `Action window must be between 1 minute and 7 days (got ${input.amount} ${input.unit})`,
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
