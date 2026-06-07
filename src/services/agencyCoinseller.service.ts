import { COINSELLER_SETTINGS_TTL, getRedisForRead, RedisKeys, redisClient } from '../config/redis'
import { s3Bucket } from '../config/s3'
import {
  agencyCoinsellerRepository,
  type CoinsellerSettingsInput,
} from '../repositories/agencyCoinseller.repository'
import { agencyRepository } from '../repositories/agency.repository'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { AppError } from '../middlewares/errorHandler'
import { storageService } from './storage.service'

const PENDING_IMAGE_TTL = 600
const pendingImageKey = (userId: string) => `agency:coinseller:pending-image:${userId}`

export const agencyCoinsellerService = {
  async getSettings(agencyUserId: string) {
    const redis = getRedisForRead()
    const cacheKey = RedisKeys.coinsellerSettings(agencyUserId)
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const row = await agencyCoinsellerRepository.findByAgencyUserId(agencyUserId)
    const kyc = !row?.whatsappNumber
      ? await agencyApplicationKycRepository.getKycByUserId(agencyUserId)
      : null
    const result = row
      ? {
          ...row,
          whatsappNumber: row.whatsappNumber ?? kyc?.contactPhone ?? null,
        }
      : {
          agencyUserId,
          transferChannel: 'EPAY' as const,
          whatsappNumber: kyc?.contactPhone ?? null,
          priceImageS3Key: null,
          priceImageS3Bucket: null,
          autoReply: null,
        }
    await redisClient.set(cacheKey, JSON.stringify(result), 'EX', COINSELLER_SETTINGS_TTL)
    return result
  },

  async updateSettings(agencyUserId: string, data: CoinsellerSettingsInput) {
    const row = await agencyCoinsellerRepository.upsertSettings(agencyUserId, data)
    await agencyCoinsellerService._bustCache(agencyUserId)
    return row
  },

  async getPriceImageUploadUrl(agencyUserId: string, mimeType?: string) {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp']
    const mime = mimeType ?? 'image/jpeg'
    if (!allowedMimeTypes.includes(mime)) {
      throw new AppError(
        400,
        'Allowed types: image/jpeg, image/png, image/webp',
        'INVALID_MIME_TYPE',
      )
    }
    const ext = mime.split('/')[1]
    const s3Key = `agency/price-images/${agencyUserId}/${Date.now()}.${ext}`
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, mime, PENDING_IMAGE_TTL)
    await redisClient.set(pendingImageKey(agencyUserId), s3Key, 'EX', PENDING_IMAGE_TTL)
    return { uploadUrl, s3Key }
  },

  async confirmPriceImage(agencyUserId: string, s3Key: string) {
    const pending = await redisClient.get(pendingImageKey(agencyUserId))
    if (!pending) {
      throw new AppError(400, 'Call upload-url first', 'PRICE_IMAGE_UPLOAD_URL_REQUIRED')
    }
    if (pending !== s3Key) {
      throw new AppError(400, 's3Key does not match the pending upload', 'PRICE_IMAGE_KEY_MISMATCH')
    }

    const bucket = s3Bucket?.trim()
    if (!bucket) {
      throw new AppError(503, 'File storage is not configured', 'S3_NOT_CONFIGURED')
    }

    const row = await agencyCoinsellerRepository.setPriceImage(agencyUserId, {
      priceImageS3Key: s3Key,
      priceImageS3Bucket: bucket,
    })

    await redisClient.del(pendingImageKey(agencyUserId))
    await agencyCoinsellerService._bustCache(agencyUserId)
    return row
  },

  async deletePriceImage(agencyUserId: string) {
    const row = await agencyCoinsellerRepository.findByAgencyUserId(agencyUserId)
    if (row?.priceImageS3Key) {
      storageService.deleteObject(row.priceImageS3Key).catch(() => {})
    }
    await agencyCoinsellerRepository.clearPriceImage(agencyUserId)
    await agencyCoinsellerService._bustCache(agencyUserId)
  },

  getPriceImageUrl(s3Key: string | null | undefined): string | null {
    if (!s3Key) return null
    return storageService.getCdnOrS3PublicUrl(s3Key)
  },

  /**
   * Copy KYC / agency contact phone into coinseller WhatsApp when the agency row exists.
   */
  async syncWhatsappFromKycPhone(agencyUserId: string, phone: string | null | undefined) {
    const normalized = phone?.trim()
    if (!normalized) return
    const agency = await agencyRepository.getAgencyByUserId(agencyUserId)
    if (!agency) return
    const existing = await agencyCoinsellerRepository.findByAgencyUserId(agencyUserId)
    await agencyCoinsellerRepository.upsertSettings(agencyUserId, {
      whatsappNumber: normalized,
      ...(existing ? {} : { transferChannel: 'EPAY' }),
    })
    await agencyCoinsellerService._bustCache(agencyUserId)
  },

  async _bustCache(agencyUserId: string) {
    await redisClient.del(RedisKeys.coinsellerSettings(agencyUserId))
  },
}
