import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../middlewares/errorHandler'

const checkImageBytesForNudity = vi.fn()
const checkImageForNudity = vi.fn()

vi.mock('../services/face-registration/face-registration-moderation.service', () => ({
  checkImageBytesForNudity: (...a: unknown[]) => checkImageBytesForNudity(...a),
  checkImageForNudity: (...a: unknown[]) => checkImageForNudity(...a),
}))

const headObjectMetadata = vi.fn()
const deleteObject = vi.fn()

vi.mock('../services/storage.service', () => ({
  storageService: {
    headObjectMetadata: (...a: unknown[]) => headObjectMetadata(...a),
    deleteObject: (...a: unknown[]) => deleteObject(...a),
  },
}))

vi.mock('../lib/rekognition.client', () => ({
  isRekognitionInvalidImageFormatError: (err: unknown) =>
    err instanceof Error && err.message === 'InvalidImageFormatException',
}))

vi.mock('../utils/rootLogger', () => ({
  rootLogger: {
    child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
  },
}))

const { envState } = vi.hoisted(() => ({
  envState: {
    AVATAR_CONTENT_MODERATION_ENABLED: true,
    FACE_CONTENT_MODERATION_ENABLED: false,
  },
}))

vi.mock('../config/env', () => ({
  env: envState,
}))

import { avatarModerationService, AVATAR_NUDITY_ERROR_CODE } from './avatar-moderation.service'

const userId = 'user-1'
const key = `avatars/${userId}/photo.jpg`
const url = `https://cdn.example.com/${key}`
const s3Url = `https://bucket.s3.ap-south-1.amazonaws.com/${key}`

describe('avatarModerationService', () => {
  beforeEach(() => {
    envState.AVATAR_CONTENT_MODERATION_ENABLED = true
    envState.FACE_CONTENT_MODERATION_ENABLED = false
    checkImageBytesForNudity.mockReset()
    checkImageForNudity.mockReset()
    headObjectMetadata.mockReset()
    deleteObject.mockReset()
    headObjectMetadata.mockResolvedValue({ contentLength: 100 })
    deleteObject.mockResolvedValue(undefined)
  })

  describe('flag gating', () => {
    it('skips entirely when AVATAR and FACE moderation are off', async () => {
      envState.AVATAR_CONTENT_MODERATION_ENABLED = false
      await expect(
        avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg')),
      ).resolves.toBeUndefined()
      await expect(
        avatarModerationService.assertAvatarUrlNotNude(userId, 'https://lh3.googleusercontent.com/a/x'),
      ).resolves.toBeUndefined()
      expect(checkImageBytesForNudity).not.toHaveBeenCalled()
      expect(checkImageForNudity).not.toHaveBeenCalled()
      expect(headObjectMetadata).not.toHaveBeenCalled()
    })

    it('runs when only FACE_CONTENT_MODERATION_ENABLED is on', async () => {
      envState.AVATAR_CONTENT_MODERATION_ENABLED = false
      envState.FACE_CONTENT_MODERATION_ENABLED = true
      checkImageBytesForNudity.mockResolvedValueOnce({ isNudityDetected: false, labels: [] })
      await avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg'))
      expect(checkImageBytesForNudity).toHaveBeenCalled()
    })
  })

  describe('assertAvatarBytesNotNude', () => {
    it('allows clean avatar bytes', async () => {
      checkImageBytesForNudity.mockResolvedValueOnce({ isNudityDetected: false, labels: [] })
      await expect(
        avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg')),
      ).resolves.toBeUndefined()
    })

    it('rejects nude avatar bytes', async () => {
      checkImageBytesForNudity.mockResolvedValueOnce({
        isNudityDetected: true,
        labels: [{ label: 'Explicit Nudity', confidence: 90 }],
      })
      await expect(
        avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg')),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: AVATAR_NUDITY_ERROR_CODE,
      })
    })

    it('maps invalid image format to INVALID_FILE_TYPE', async () => {
      checkImageBytesForNudity.mockRejectedValueOnce(new Error('InvalidImageFormatException'))
      await expect(
        avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg')),
      ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE', statusCode: 400 })
    })

    it('fail-opens on Rekognition circuit / infra errors (does not block PATCH)', async () => {
      checkImageBytesForNudity.mockRejectedValueOnce(
        new AppError(502, 'Face recognition service temporarily unavailable', 'REKOGNITION_CIRCUIT_OPEN'),
      )
      await expect(
        avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg')),
      ).resolves.toBeUndefined()
    })

    it('fail-opens on unexpected scan exceptions', async () => {
      checkImageBytesForNudity.mockRejectedValueOnce(new Error('timeout'))
      await expect(
        avatarModerationService.assertAvatarBytesNotNude(Buffer.from('jpeg')),
      ).resolves.toBeUndefined()
    })
  })

  describe('assertAvatarUrlNotNude', () => {
    it('skips scan for non-owned URLs (no mobile contract change)', async () => {
      await expect(
        avatarModerationService.assertAvatarUrlNotNude(userId, 'https://cdn.example.com/other.jpg'),
      ).resolves.toBeUndefined()
      expect(checkImageForNudity).not.toHaveBeenCalled()
      expect(headObjectMetadata).not.toHaveBeenCalled()
    })

    it('skips scan for Google / external profile photo URLs', async () => {
      await expect(
        avatarModerationService.assertAvatarUrlNotNude(
          userId,
          'https://lh3.googleusercontent.com/a/ACg8ocExample',
        ),
      ).resolves.toBeUndefined()
      expect(checkImageForNudity).not.toHaveBeenCalled()
    })

    it('skips scan when owned S3 object is missing (no new client error)', async () => {
      headObjectMetadata.mockRejectedValueOnce(
        new AppError(400, 'Uploaded object not found', 'INVALID_MEDIA_OBJECT'),
      )
      await expect(avatarModerationService.assertAvatarUrlNotNude(userId, url)).resolves.toBeUndefined()
      expect(checkImageForNudity).not.toHaveBeenCalled()
    })

    it('fail-opens when HeadObject has infra failure', async () => {
      headObjectMetadata.mockRejectedValueOnce(
        new AppError(502, 'File storage temporarily unavailable', 'S3_METADATA_FAILED'),
      )
      await expect(avatarModerationService.assertAvatarUrlNotNude(userId, url)).resolves.toBeUndefined()
      expect(checkImageForNudity).not.toHaveBeenCalled()
    })

    it('deletes S3 object when complete-profile avatar is nude', async () => {
      checkImageForNudity.mockResolvedValueOnce({
        isNudityDetected: true,
        labels: [{ label: 'Explicit Nudity', confidence: 88 }],
      })
      await expect(avatarModerationService.assertAvatarUrlNotNude(userId, url)).rejects.toMatchObject({
        code: AVATAR_NUDITY_ERROR_CODE,
      })
      expect(deleteObject).toHaveBeenCalledWith(key)
    })

    it('allows a clean owned CDN avatar URL', async () => {
      checkImageForNudity.mockResolvedValueOnce({ isNudityDetected: false, labels: [] })
      await expect(avatarModerationService.assertAvatarUrlNotNude(userId, url)).resolves.toBeUndefined()
      expect(deleteObject).not.toHaveBeenCalled()
    })

    it('allows a clean owned virtual-hosted S3 avatar URL', async () => {
      checkImageForNudity.mockResolvedValueOnce({ isNudityDetected: false, labels: [] })
      await expect(avatarModerationService.assertAvatarUrlNotNude(userId, s3Url)).resolves.toBeUndefined()
      expect(checkImageForNudity).toHaveBeenCalledWith(key, { forceEnabled: true })
    })

    it('fail-opens on Rekognition infra error during URL scan', async () => {
      checkImageForNudity.mockRejectedValueOnce(
        new AppError(502, 'Face recognition service temporarily unavailable', 'REKOGNITION_CIRCUIT_OPEN'),
      )
      await expect(avatarModerationService.assertAvatarUrlNotNude(userId, url)).resolves.toBeUndefined()
      expect(deleteObject).not.toHaveBeenCalled()
    })
  })
})
