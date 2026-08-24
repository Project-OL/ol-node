import { redisClient, RedisKeys, SUPPORT_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  DEFAULT_SUPPORT_REVIEW_WINDOW_MS,
  supportConfigRepository,
} from '../repositories/supportConfig.repository'
import type { SupportConfigUpdateInput } from '../models/supportConfig.schemas'
import {
  amountUnitToMs,
  toDisplayAmountUnit,
  type MessagingActionWindowUnit,
} from './messagingConfig.service'

const MIN_WINDOW_MS = 1_000
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export type SupportConfigDto = {
  amount: number
  unit: MessagingActionWindowUnit
  windowMs: number
  windowMinutes: number
  windowSeconds: number
  updatedAt: string
}

function serialize(row: { reviewWindowMs: number; updatedAt: Date }): SupportConfigDto {
  const windowMs = row.reviewWindowMs > 0 ? row.reviewWindowMs : DEFAULT_SUPPORT_REVIEW_WINDOW_MS
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

/** Human label for chat notices, e.g. "24 hours", "90 seconds". */
export function formatSupportReviewWindowLabel(windowMs: number): string {
  const { amount, unit } = toDisplayAmountUnit(windowMs)
  if (unit === 'hours') return `${amount} hour${amount === 1 ? '' : 's'}`
  if (unit === 'minutes') return `${amount} minute${amount === 1 ? '' : 's'}`
  return `${amount} second${amount === 1 ? '' : 's'}`
}

export async function supportContestEndsAt(
  resolvedAt: Date | null | undefined,
): Promise<string | null> {
  if (!resolvedAt) return null
  const windowMs = await supportConfigService.getReviewWindowMs()
  return new Date(resolvedAt.getTime() + windowMs).toISOString()
}

export const supportConfigService = {
  async getConfig(): Promise<SupportConfigDto> {
    const key = RedisKeys.supportConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as SupportConfigDto
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

    const row = await supportConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, SUPPORT_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async getReviewWindowMs(): Promise<number> {
    const cfg = await supportConfigService.getConfig()
    return cfg.windowMs > 0 ? cfg.windowMs : DEFAULT_SUPPORT_REVIEW_WINDOW_MS
  },

  async bustCache() {
    await redisClient.del(RedisKeys.supportConfig())
  },

  async updateConfig(
    adminUserId: string,
    input: SupportConfigUpdateInput,
  ): Promise<SupportConfigDto> {
    const rawMs = amountUnitToMs(input.amount, input.unit)
    if (rawMs < MIN_WINDOW_MS || rawMs > MAX_WINDOW_MS) {
      throw new AppError(
        400,
        `Review window must be between 1 second and 7 days (got ${input.amount} ${input.unit})`,
        'INVALID_SUPPORT_REVIEW_WINDOW',
      )
    }

    const row = await supportConfigRepository.update({
      reviewWindowMs: rawMs,
      updatedByUserId: adminUserId,
    })
    await supportConfigService.bustCache()
    return serialize(row)
  },
}
