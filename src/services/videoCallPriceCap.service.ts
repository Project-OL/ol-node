import {
  DEFAULT_VIDEO_CALL_PRICE_CAPS,
  MIN_CALL_PRICE_COINS_PER_MIN,
} from '../config/video-call-price-caps.defaults'
import { RedisKeys, SYSTEM_RATES_CONFIG_TTL, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { videoCallPriceCapRepository } from '../repositories/videoCallPriceCap.repository'

export type VideoCallPriceCapTier = {
  minLevel: number
  maxLevel: number | null
  price: number
  label: string | null
  sortOrder: number
}

export type VideoCallPriceCapInput = {
  minLevel: number
  maxLevel?: number | null
  price: number
  label?: string | null
}

/** App price-table row (keeps maxLevel/maxPrice for existing clients). */
export type VideoCallPriceTableRow = {
  label: string
  minLevel: number
  maxLevel: number | null
  /** Allowed pricePerMin for this band (alias of maxPrice). */
  price: number
  /** @deprecated Prefer `price` — kept additive for older clients. */
  maxPrice: number
}

function formatTier(row: {
  minLevel: number
  maxLevel: number | null
  price: number
  label: string | null
  sortOrder: number
}): VideoCallPriceCapTier {
  return {
    minLevel: row.minLevel,
    maxLevel: row.maxLevel,
    price: row.price,
    label: row.label,
    sortOrder: row.sortOrder,
  }
}

function defaultTiers(): VideoCallPriceCapTier[] {
  return DEFAULT_VIDEO_CALL_PRICE_CAPS.map((t, i) => ({
    minLevel: t.minLevel,
    maxLevel: t.maxLevel,
    price: t.price,
    label: t.label,
    sortOrder: i + 1,
  }))
}

function matchesLevel(tier: VideoCallPriceCapTier, livestreamLevel: number): boolean {
  if (livestreamLevel < tier.minLevel) return false
  if (tier.maxLevel != null && livestreamLevel > tier.maxLevel) return false
  return true
}

function validateTiers(tiers: VideoCallPriceCapInput[]): void {
  if (tiers.length === 0) {
    throw new AppError(400, 'At least one price tier is required', 'VALIDATION_ERROR')
  }
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]!
    if (!Number.isInteger(t.minLevel) || t.minLevel < 1) {
      throw new AppError(400, `tiers[${i}].minLevel must be an integer ≥ 1`, 'VALIDATION_ERROR')
    }
    if (t.maxLevel != null) {
      if (!Number.isInteger(t.maxLevel) || t.maxLevel < t.minLevel) {
        throw new AppError(
          400,
          `tiers[${i}].maxLevel must be null or an integer ≥ minLevel`,
          'VALIDATION_ERROR',
        )
      }
    }
    if (!Number.isInteger(t.price) || t.price < 1) {
      throw new AppError(400, `tiers[${i}].price must be a positive integer`, 'VALIDATION_ERROR')
    }
  }
}

export const videoCallPriceCapService = {
  async bustCache(): Promise<void> {
    try {
      await redisClient.del(RedisKeys.videoCallPriceCaps())
    } catch {
      /* ignore */
    }
  },

  async getCaps(): Promise<{ tiers: VideoCallPriceCapTier[] }> {
    const key = RedisKeys.videoCallPriceCaps()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as { tiers: VideoCallPriceCapTier[] }
    } catch {
      /* miss */
    }

    let tiers: VideoCallPriceCapTier[]
    try {
      const rows = await videoCallPriceCapRepository.findActive()
      tiers = rows.length > 0 ? rows.map(formatTier) : defaultTiers()
    } catch {
      tiers = defaultTiers()
    }

    const dto = { tiers }
    try {
      await redisClient.setex(key, SYSTEM_RATES_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async replaceCaps(tiers: VideoCallPriceCapInput[]): Promise<{ tiers: VideoCallPriceCapTier[] }> {
    validateTiers(tiers)
    await videoCallPriceCapRepository.softReplace(
      tiers.map((t) => ({
        minLevel: t.minLevel,
        maxLevel: t.maxLevel ?? null,
        price: t.price,
        label: t.label ?? null,
      })),
    )
    await this.bustCache()
    return this.getCaps()
  },

  /** Distinct allowed pricePerMin values for a host livestream level (sorted ascending). */
  async getAllowedPricesForLevel(livestreamLevel: number): Promise<number[]> {
    const { tiers } = await this.getCaps()
    const prices = tiers.filter((t) => matchesLevel(t, livestreamLevel)).map((t) => t.price)
    return [...new Set(prices)].sort((a, b) => a - b)
  },

  /** Highest allowed price for the level (0 if none configured). */
  async getMaxPriceForLevel(livestreamLevel: number): Promise<number> {
    const allowed = await this.getAllowedPricesForLevel(livestreamLevel)
    if (allowed.length === 0) return MIN_CALL_PRICE_COINS_PER_MIN
    return allowed[allowed.length - 1]!
  },

  async assertPriceAllowed(livestreamLevel: number, pricePerMin: number): Promise<void> {
    const allowedPrices = await this.getAllowedPricesForLevel(livestreamLevel)
    if (allowedPrices.length === 0) {
      throw new AppError(
        400,
        'No video-call prices are configured for your livestream level',
        'PRICE_EXCEEDS_CAP',
        { cap: 0, livestreamLevel, allowedPrices },
      )
    }
    if (!allowedPrices.includes(pricePerMin)) {
      const cap = allowedPrices[allowedPrices.length - 1]!
      throw new AppError(
        400,
        `Your livestream level (Lv${livestreamLevel}) allows prices: ${allowedPrices.join(', ')}`,
        'PRICE_EXCEEDS_CAP',
        { cap, livestreamLevel, allowedPrices },
      )
    }
  },

  async priceTable(): Promise<VideoCallPriceTableRow[]> {
    const { tiers } = await this.getCaps()
    return tiers.map((t) => ({
      label: t.label ?? (t.maxLevel == null ? `Lv${t.minLevel}+` : `Lv${t.minLevel}-${t.maxLevel}`),
      minLevel: t.minLevel,
      maxLevel: t.maxLevel,
      price: t.price,
      maxPrice: t.price,
    }))
  },
}
