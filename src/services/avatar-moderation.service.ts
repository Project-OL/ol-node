import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import { isRekognitionInvalidImageFormatError } from '../lib/rekognition.client'
import { parseOwnedAvatarS3Key } from '../utils/avatar-s3-key'
import { rootLogger } from '../utils/rootLogger'
import {
  checkImageBytesForNudity,
  checkImageForNudity,
} from './face-registration/face-registration-moderation.service'
import { storageService } from './storage.service'

export const AVATAR_NUDITY_ERROR_CODE = 'AVATAR_NUDITY_DETECTED'

const AVATAR_NUDITY_MESSAGE =
  'This photo cannot be used as a profile picture. Please choose a different image.'

const log = rootLogger.child({ module: 'avatar-moderation' })

function isAvatarModerationEnabled(): boolean {
  return env.AVATAR_CONTENT_MODERATION_ENABLED || env.FACE_CONTENT_MODERATION_ENABLED
}

function throwNudityDetected(): never {
  throw new AppError(400, AVATAR_NUDITY_MESSAGE, AVATAR_NUDITY_ERROR_CODE)
}

function isClientAvatarRejection(err: unknown): boolean {
  if (!(err instanceof AppError)) return false
  return err.code === AVATAR_NUDITY_ERROR_CODE || err.code === 'INVALID_FILE_TYPE'
}

/**
 * Client/policy rejections still throw. Infra / Rekognition outages fail-open so
 * signup and PATCH /users/me are not blocked when AWS is down.
 */
function handleScanFailure(err: unknown, context: string): void {
  if (isClientAvatarRejection(err)) throw err
  if (isRekognitionInvalidImageFormatError(err)) {
    throw new AppError(400, 'Avatar must be JPEG, PNG, or WEBP', 'INVALID_FILE_TYPE')
  }
  log.warn({ err, context }, 'avatar_moderation_skipped_infra_error')
}

export const avatarModerationService = {
  /** Scan in-memory bytes before S3 put (PATCH /users/me). No client contract change. */
  async assertAvatarBytesNotNude(imageBytes: Buffer): Promise<void> {
    if (!isAvatarModerationEnabled()) return
    try {
      const result = await checkImageBytesForNudity(new Uint8Array(imageBytes), {
        forceEnabled: true,
      })
      if (result.isNudityDetected) throwNudityDetected()
    } catch (err) {
      handleScanFailure(err, 'assertAvatarBytesNotNude')
    }
  },

  /**
   * Complete-profile `avatarUrl`: scan only when URL is this user's
   * `avatars/{userId}/…` object (existing presigned upload flow). Other URLs
   * (Google, etc.) are left unchanged — no mobile app change required.
   */
  async assertAvatarUrlNotNude(userId: string, avatarUrl: string): Promise<void> {
    if (!isAvatarModerationEnabled()) return
    const key = parseOwnedAvatarS3Key(avatarUrl, userId)
    if (!key) {
      // Not our S3 avatar key — keep previous accept-any-URL behavior for clients.
      log.info({ userId }, 'avatar_moderation_skipped_non_owned_url')
      return
    }
    try {
      await storageService.headObjectMetadata(key)
    } catch (err) {
      if (err instanceof AppError && err.code === 'INVALID_MEDIA_OBJECT') {
        // Object not uploaded yet / stale URL — do not introduce a new client error.
        log.warn({ userId, key }, 'avatar_moderation_skipped_missing_object')
        return
      }
      handleScanFailure(err, 'assertAvatarUrlNotNude.head')
      return
    }
    try {
      const result = await checkImageForNudity(key, { forceEnabled: true })
      if (result.isNudityDetected) {
        await storageService.deleteObject(key).catch(() => undefined)
        throwNudityDetected()
      }
    } catch (err) {
      handleScanFailure(err, 'assertAvatarUrlNotNude.scan')
    }
  },
}
