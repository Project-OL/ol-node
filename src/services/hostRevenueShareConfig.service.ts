import {
  DEFAULT_HOST_REVENUE_SHARES,
  LUCKY_HOST_SHARE_BP_RANGE,
  LUCKY_TARGET_RTP_BP_RANGE,
  type HostRevenueShares,
} from '../config/host-revenue-shares'
import { RedisKeys, SYSTEM_RATES_CONFIG_TTL, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { hostRevenueShareConfigRepository } from '../repositories/hostRevenueShareConfig.repository'

export type HostRevenueShareConfigDto = HostRevenueShares & {
  updatedAt: string | null
  updatedByAdminId: string | null
}

function serialize(row: {
  giftReceiveBp: number
  subscriptionBp: number
  guardianPurchaseBp: number
  videoCallHostShareBp: number
  luckyHostShareBp: number
  luckyTargetRtpBp: number
  updatedAt: Date
  updatedByAdminId: string | null
}): HostRevenueShareConfigDto {
  return {
    giftReceiveBp: row.giftReceiveBp,
    subscriptionBp: row.subscriptionBp,
    guardianPurchaseBp: row.guardianPurchaseBp,
    videoCallHostShareBp: row.videoCallHostShareBp,
    luckyHostShareBp: row.luckyHostShareBp,
    luckyTargetRtpBp: row.luckyTargetRtpBp,
    updatedAt: row.updatedAt.toISOString(),
    updatedByAdminId: row.updatedByAdminId,
  }
}

function defaultsDto(): HostRevenueShareConfigDto {
  return {
    ...DEFAULT_HOST_REVENUE_SHARES,
    updatedAt: null,
    updatedByAdminId: null,
  }
}

export const hostRevenueShareConfigService = {
  async getConfig(): Promise<HostRevenueShareConfigDto> {
    // `host:revenue-shares` is also read by Live-server (lucky host cut + RTP target).
    const key = RedisKeys.hostRevenueShares()
    try {
      const hit = await redisClient.get(key)
      // Merged over the defaults: a snapshot cached before a field existed still reads complete.
      if (hit) return { ...defaultsDto(), ...(JSON.parse(hit) as Partial<HostRevenueShareConfigDto>) }
    } catch {
      /* miss */
    }

    try {
      const row = await hostRevenueShareConfigRepository.getOrCreate()
      const dto = serialize(row)
      try {
        await redisClient.setex(key, SYSTEM_RATES_CONFIG_TTL, JSON.stringify(dto))
      } catch {
        /* ignore */
      }
      return dto
    } catch {
      return defaultsDto()
    }
  },

  /** Runtime shares used by gift / subscription / guardian / video-call / lucky credit paths. */
  async getShares(): Promise<HostRevenueShares> {
    const cfg = await this.getConfig()
    return {
      giftReceiveBp: cfg.giftReceiveBp,
      subscriptionBp: cfg.subscriptionBp,
      guardianPurchaseBp: cfg.guardianPurchaseBp,
      videoCallHostShareBp: cfg.videoCallHostShareBp,
      luckyHostShareBp: cfg.luckyHostShareBp,
      luckyTargetRtpBp: cfg.luckyTargetRtpBp,
    }
  },

  async bustCache() {
    await redisClient.del(RedisKeys.hostRevenueShares())
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      giftReceiveBp?: number
      subscriptionBp?: number
      guardianPurchaseBp?: number
      videoCallHostShareBp?: number
      luckyHostShareBp?: number
      luckyTargetRtpBp?: number
    },
  ): Promise<HostRevenueShareConfigDto> {
    const hasAny = Object.values(updates).some((v) => v != null)
    if (!hasAny) {
      throw new AppError(400, 'Provide at least one share field', 'VALIDATION_ERROR')
    }

    const { luckyHostShareBp, luckyTargetRtpBp, ...hostShares } = updates
    for (const [name, v] of Object.entries(hostShares)) {
      if (v == null) continue
      if (!Number.isInteger(v) || v < 1 || v > 10_000) {
        throw new AppError(422, `${name} must be an integer 1–10000 bp`, 'INVALID_SHARE_BP')
      }
    }
    const inRange = (v: number, r: { min: number; max: number }) =>
      Number.isInteger(v) && v >= r.min && v <= r.max
    if (luckyHostShareBp != null && !inRange(luckyHostShareBp, LUCKY_HOST_SHARE_BP_RANGE)) {
      throw new AppError(
        422,
        `luckyHostShareBp must be an integer ${LUCKY_HOST_SHARE_BP_RANGE.min}–${LUCKY_HOST_SHARE_BP_RANGE.max} bp`,
        'INVALID_SHARE_BP',
      )
    }
    if (luckyTargetRtpBp != null && !inRange(luckyTargetRtpBp, LUCKY_TARGET_RTP_BP_RANGE)) {
      throw new AppError(
        422,
        `luckyTargetRtpBp must be an integer ${LUCKY_TARGET_RTP_BP_RANGE.min}–${LUCKY_TARGET_RTP_BP_RANGE.max} bp`,
        'INVALID_SHARE_BP',
      )
    }

    const row = await hostRevenueShareConfigRepository.update({
      ...updates,
      updatedByAdminId: adminUserId,
    })
    await this.bustCache()
    return serialize(row)
  },
}
