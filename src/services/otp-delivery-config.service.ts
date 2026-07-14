import {
  OTP_DELIVERY_CONFIG_TTL,
  OTP_SMS_TRIGGER_AFTER_COUNT,
  OTP_SMS_TRIGGER_INTERVAL_SEC_DEFAULT,
  RedisKeys,
  redisClient,
} from '../config/redis'
import { otpDeliveryConfigRepository } from '../repositories/otpDeliveryConfig.repository'

export type OtpDeliveryConfigDto = {
  /** Within this many seconds, OTP request count for a phone selects the channel. */
  smsTriggerIntervalSec: number
  /** Request number at which SMS is preferred (requests 1..N-1 use WhatsApp first). */
  smsTriggerAfterCount: number
  updatedAt: string
}

function serialize(row: { smsTriggerIntervalSec: number; updatedAt: Date }): OtpDeliveryConfigDto {
  return {
    smsTriggerIntervalSec: row.smsTriggerIntervalSec,
    smsTriggerAfterCount: OTP_SMS_TRIGGER_AFTER_COUNT,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export const otpDeliveryConfigService = {
  async getConfig(): Promise<OtpDeliveryConfigDto> {
    const key = RedisKeys.otpDeliveryConfig()
    try {
      const hit = await redisClient.get(key)
      if (hit) return JSON.parse(hit) as OtpDeliveryConfigDto
    } catch {
      /* miss */
    }

    const row = await otpDeliveryConfigRepository.getOrCreate()
    const dto = serialize(row)
    try {
      await redisClient.setex(key, OTP_DELIVERY_CONFIG_TTL, JSON.stringify(dto))
    } catch {
      /* ignore */
    }
    return dto
  },

  async getSmsTriggerIntervalSec(): Promise<number> {
    try {
      const cfg = await otpDeliveryConfigService.getConfig()
      return cfg.smsTriggerIntervalSec > 0
        ? cfg.smsTriggerIntervalSec
        : OTP_SMS_TRIGGER_INTERVAL_SEC_DEFAULT
    } catch {
      return OTP_SMS_TRIGGER_INTERVAL_SEC_DEFAULT
    }
  },

  async bustCache() {
    await redisClient.del(RedisKeys.otpDeliveryConfig())
  },

  async updateConfig(
    adminUserId: string,
    updates: { smsTriggerIntervalSec: number },
  ): Promise<OtpDeliveryConfigDto> {
    await otpDeliveryConfigRepository.getOrCreate()
    const row = await otpDeliveryConfigRepository.update({
      smsTriggerIntervalSec: updates.smsTriggerIntervalSec,
      updatedByUserId: adminUserId,
    })
    await otpDeliveryConfigService.bustCache()
    return serialize(row)
  },
}
