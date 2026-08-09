import { redisClient, RedisKeys, PAYOUT_RAIL_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { withdrawalPayoutRailConfigRepository } from '../repositories/withdrawalPayoutRailConfig.repository'

export type PayoutRailPublicDto = {
  epay: {
    feeRateBp: number
    feePercent: number
    arrivalTime: string
    enabled: boolean
  }
  bank: {
    feeRateBp: number
    feePercent: number
    arrivalTime: string
    enabled: boolean
  }
  updatedAt: string
}

function toRailDto(feeRateBp: number, arrivalTime: string, enabled: boolean) {
  return {
    feeRateBp,
    feePercent: feeRateBp / 100,
    arrivalTime,
    enabled,
  }
}

function serialize(row: {
  epayFeeRateBp: number
  epayArrivalTime: string
  epayEnabled: boolean
  bankFeeRateBp: number
  bankArrivalTime: string
  bankEnabled: boolean
  updatedAt: Date
}): PayoutRailPublicDto {
  return {
    epay: toRailDto(row.epayFeeRateBp, row.epayArrivalTime, row.epayEnabled),
    bank: toRailDto(row.bankFeeRateBp, row.bankArrivalTime, row.bankEnabled),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const withdrawalPayoutRailConfigService = {
  async getPublicConfig(): Promise<PayoutRailPublicDto> {
    const key = RedisKeys.payoutRailConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) {
        const parsed = JSON.parse(hit) as PayoutRailPublicDto
        // Back-compat for warm cache written before `enabled` existed.
        if (parsed.epay && typeof parsed.epay.enabled !== 'boolean') {
          parsed.epay.enabled = true
        }
        if (parsed.bank && typeof parsed.bank.enabled !== 'boolean') {
          parsed.bank.enabled = true
        }
        return parsed
      }
    } catch {
      /* miss */
    }

    const row = await withdrawalPayoutRailConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, PAYOUT_RAIL_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async bustCache() {
    await redisClient.del(RedisKeys.payoutRailConfig())
  },

  /** Throws 403 PAYMENT_METHOD_DISABLED when the rail is admin-disabled. */
  async assertRailEnabled(methodType: 'EPAY' | 'BANK'): Promise<void> {
    const config = await withdrawalPayoutRailConfigService.getPublicConfig()
    const rail = methodType === 'EPAY' ? config.epay : config.bank
    if (!rail.enabled) {
      throw new AppError(
        403,
        `${methodType} payment method is currently disabled`,
        'PAYMENT_METHOD_DISABLED',
      )
    }
  },

  async updateConfig(
    adminUserId: string,
    updates: {
      epay?: { feeRateBp?: number; arrivalTime?: string; enabled?: boolean }
      bank?: { feeRateBp?: number; arrivalTime?: string; enabled?: boolean }
    },
  ): Promise<PayoutRailPublicDto> {
    const current = await withdrawalPayoutRailConfigRepository.getOrCreate()
    const data: {
      epayFeeRateBp?: number
      epayArrivalTime?: string
      epayEnabled?: boolean
      bankFeeRateBp?: number
      bankArrivalTime?: string
      bankEnabled?: boolean
      updatedByUserId: string
    } = { updatedByUserId: adminUserId }

    if (updates.epay?.feeRateBp != null) {
      data.epayFeeRateBp = updates.epay.feeRateBp
    }
    if (updates.epay?.arrivalTime != null) {
      data.epayArrivalTime = updates.epay.arrivalTime
    }
    if (updates.epay?.enabled != null) {
      data.epayEnabled = updates.epay.enabled
    }
    if (updates.bank?.feeRateBp != null) {
      data.bankFeeRateBp = updates.bank.feeRateBp
    }
    if (updates.bank?.arrivalTime != null) {
      data.bankArrivalTime = updates.bank.arrivalTime
    }
    if (updates.bank?.enabled != null) {
      data.bankEnabled = updates.bank.enabled
    }

    const row = await withdrawalPayoutRailConfigRepository.update({
      epayFeeRateBp: data.epayFeeRateBp ?? current.epayFeeRateBp,
      epayArrivalTime: data.epayArrivalTime ?? current.epayArrivalTime,
      epayEnabled: data.epayEnabled ?? current.epayEnabled,
      bankFeeRateBp: data.bankFeeRateBp ?? current.bankFeeRateBp,
      bankArrivalTime: data.bankArrivalTime ?? current.bankArrivalTime,
      bankEnabled: data.bankEnabled ?? current.bankEnabled,
      updatedByUserId: adminUserId,
    })

    await withdrawalPayoutRailConfigService.bustCache()
    return serialize(row)
  },
}
