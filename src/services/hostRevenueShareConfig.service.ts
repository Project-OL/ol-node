import { DEFAULT_HOST_REVENUE_SHARES, type HostRevenueShares } from '../config/host-revenue-shares'
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
  updatedAt: Date
  updatedByAdminId: string | null
}): HostRevenueShareConfigDto {
  return {
    giftReceiveBp: row.giftReceiveBp,
    subscriptionBp: row.subscriptionBp,
    guardianPurchaseBp: row.guardianPurchaseBp,
    videoCallHostShareBp: row.videoCallHostShareBp,
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
    const key = RedisKeys.hostRevenueShares()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as HostRevenueShareConfigDto
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

  /** Runtime shares used by gift / subscription / guardian / video-call credit paths. */
  async getShares(): Promise<HostRevenueShares> {
    const cfg = await this.getConfig()
    return {
      giftReceiveBp: cfg.giftReceiveBp,
      subscriptionBp: cfg.subscriptionBp,
      guardianPurchaseBp: cfg.guardianPurchaseBp,
      videoCallHostShareBp: cfg.videoCallHostShareBp,
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
    },
  ): Promise<HostRevenueShareConfigDto> {
    const hasAny =
      updates.giftReceiveBp != null ||
      updates.subscriptionBp != null ||
      updates.guardianPurchaseBp != null ||
      updates.videoCallHostShareBp != null
    if (!hasAny) {
      throw new AppError(400, 'Provide at least one share field', 'VALIDATION_ERROR')
    }

    for (const [name, v] of Object.entries(updates)) {
      if (v == null) continue
      if (!Number.isInteger(v) || v < 1 || v > 10_000) {
        throw new AppError(422, `${name} must be an integer 1–10000 bp`, 'INVALID_SHARE_BP')
      }
    }

    const row = await hostRevenueShareConfigRepository.update({
      ...updates,
      updatedByAdminId: adminUserId,
    })
    await this.bustCache()
    return serialize(row)
  },
}
