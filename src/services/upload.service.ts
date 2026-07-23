import crypto from 'crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, s3Bucket } from '../config/s3'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { storageService } from './storage.service'
import type { GetUploadUrlsInput } from '../models/messaging.schemas'
import {
  AUDIO_ALLOWED_MIMES,
  audioExtensionForMime,
  extensionMatchesAudioMime,
  isMimeAllowedForAudio,
  MESSAGING_AUDIO_WAV_MAX_BYTES,
  normalizeAudioMime,
} from '../lib/message-audio.constants'

const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const PRESIGNED_URL_EXPIRES_IN = 300

function buildPublicUrl(key: string): string {
  return `https://${s3Bucket}.s3.${env.AWS_REGION}.amazonaws.com/${key}`
}

export const uploadService = {
  async generatePresignedAvatarUrl(userId: string, contentType: string) {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }

    const ext = ALLOWED_CONTENT_TYPES[contentType]
    if (!ext) {
      throw new AppError(
        400,
        `Unsupported content type. Allowed: ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')}`,
        'INVALID_CONTENT_TYPE',
      )
    }

    const key = `avatars/${userId}/${crypto.randomUUID()}.${ext}`

    const command = new PutObjectCommand({
      Bucket: s3Bucket,
      Key: key,
      ContentType: contentType,
    })

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGNED_URL_EXPIRES_IN,
    })

    return {
      uploadUrl,
      key,
      publicUrl: buildPublicUrl(key),
      expiresIn: PRESIGNED_URL_EXPIRES_IN,
    }
  },

  async getMessageMediaUploadUrls(
    userId: string,
    input: GetUploadUrlsInput,
  ): Promise<
    Array<{
      s3Key: string
      s3Bucket: string
      publicUrl: string
      uploadUrl: string
      mediaType: string
      order: number
      expiresInSec: number
    }>
  > {
    if (!s3Bucket) {
      throw new AppError(500, 'S3 bucket not configured', 'S3_NOT_CONFIGURED')
    }
    const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm']
    const IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 10MB
    const VIDEO_MAX_BYTES = 100 * 1024 * 1024 // 100MB
    const AUDIO_MAX_BYTES = 25 * 1024 * 1024 // 25MB
    const FILE_MAX_BYTES = 50 * 1024 * 1024 // 50MB
    const byType = { IMAGE: 0, VIDEO: 0, AUDIO: 0, FILE: 0 }
    const result: Array<{
      s3Key: string
      s3Bucket: string
      publicUrl: string
      uploadUrl: string
      mediaType: string
      order: number
      expiresInSec: number
    }> = []
    const conversationId = input.conversationId
    for (let i = 0; i < input.files.length; i++) {
      const file = input.files[i]
      if (file.mediaType === 'IMAGE') {
        byType.IMAGE += 1
        if (byType.IMAGE > 5) {
          throw new AppError(400, 'Max 5 image items', 'INVALID_REQUEST', { field: 'files' })
        }
        if (file.sizeBytes > IMAGE_MAX_BYTES) {
          throw new AppError(400, 'Image max 10MB each', 'INVALID_REQUEST', { field: 'files' })
        }
        if (!IMAGE_MIME.includes(file.mimeType)) {
          throw new AppError(
            400,
            `Image mimeType must be one of: ${IMAGE_MIME.join(', ')}`,
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
      } else if (file.mediaType === 'VIDEO') {
        byType.VIDEO += 1
        if (byType.VIDEO > 5) {
          throw new AppError(400, 'Max 5 video items', 'INVALID_REQUEST', { field: 'files' })
        }
        if (file.sizeBytes > VIDEO_MAX_BYTES) {
          throw new AppError(400, 'Video max 100MB each', 'INVALID_REQUEST', { field: 'files' })
        }
        if (!VIDEO_MIME.includes(file.mimeType)) {
          throw new AppError(
            400,
            `Video mimeType must be one of: ${VIDEO_MIME.join(', ')}`,
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
      } else if (file.mediaType === 'AUDIO') {
        byType.AUDIO += 1
        if (byType.AUDIO > 1) {
          throw new AppError(400, 'Max 1 audio item', 'INVALID_REQUEST', { field: 'files' })
        }
        const nm = normalizeAudioMime(file.mimeType)
        if (!isMimeAllowedForAudio(nm)) {
          throw new AppError(
            400,
            `Audio mimeType must be one of: ${AUDIO_ALLOWED_MIMES.join(', ')}`,
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        const extFromName = (file.fileName.split('.').pop() ?? '').toLowerCase()
        if (!extensionMatchesAudioMime(nm, extFromName)) {
          throw new AppError(
            400,
            'Audio file extension does not match declared MIME type',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        const maxAudio =
          nm === 'audio/wav' || nm === 'audio/x-wav' || nm === 'audio/wave'
            ? MESSAGING_AUDIO_WAV_MAX_BYTES
            : AUDIO_MAX_BYTES
        if (file.sizeBytes > maxAudio) {
          throw new AppError(
            400,
            nm.startsWith('audio/wav')
              ? `WAV audio max ${MESSAGING_AUDIO_WAV_MAX_BYTES} bytes`
              : 'Audio max 25MB each',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        if (!conversationId) {
          throw new AppError(
            400,
            'conversationId is required for audio uploads',
            'INVALID_REQUEST',
            { field: 'conversationId' },
          )
        }
      } else {
        byType.FILE += 1
        if (byType.FILE > 5) {
          throw new AppError(400, 'Max 5 file items', 'INVALID_REQUEST', { field: 'files' })
        }
        if (file.sizeBytes > FILE_MAX_BYTES) {
          throw new AppError(400, 'File max 50MB each', 'INVALID_REQUEST', { field: 'files' })
        }
      }
      let s3Key: string
      if (file.mediaType === 'AUDIO' && conversationId) {
        const d = new Date()
        const yyyy = String(d.getUTCFullYear())
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
        const ext = audioExtensionForMime(file.mimeType)
        s3Key = `messaging/audio/${conversationId}/${yyyy}/${mm}/${crypto.randomUUID()}.${ext}`
      } else {
        const ext =
          file.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ||
          file.fileName.split('.').pop() ||
          'bin'
        s3Key = `messaging/${userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
      }
      const presignTtl = 300
      const uploadUrl = await storageService.getPresignedPutUrl(
        s3Key,
        file.mimeType.split(';')[0]!.trim(),
        presignTtl,
        file.mediaType === 'AUDIO'
          ? { cacheControl: 'public, max-age=31536000, immutable' }
          : undefined,
      )
      const publicUrl = storageService.getCdnOrS3PublicUrl(s3Key)
      result.push({
        s3Key,
        s3Bucket: s3Bucket,
        publicUrl,
        uploadUrl,
        mediaType: file.mediaType,
        order: i,
        expiresInSec: presignTtl,
      })
    }
    return result
  },

  async getReportEvidenceUploadUrls(
    userId: string,
    count: number,
  ): Promise<Array<{ s3Key: string; uploadUrl: string }>> {
    if (count < 1 || count > 5) {
      throw new AppError(400, 'Count must be between 1 and 5', 'INVALID_REQUEST')
    }
    const result: Array<{ s3Key: string; uploadUrl: string }> = []
    const ts = Date.now()
    for (let i = 0; i < count; i++) {
      const s3Key = `reports/${userId}/${ts}-${i}.jpg`
      const uploadUrl = await storageService.getPresignedPutUrl(s3Key, 'image/jpeg', 300)
      result.push({ s3Key, uploadUrl })
    }
    return result
  },

  /** Additive v2: image + video evidence (the original count-only endpoint stays image/jpeg-only for old clients). */
  async getReportEvidenceUploadUrlsV2(
    userId: string,
    files: Array<{ mediaType: 'IMAGE' | 'VIDEO'; fileName: string; mimeType: string; sizeBytes: number }>,
  ): Promise<
    Array<{ s3Key: string; uploadUrl: string; publicUrl: string; mediaType: string; expiresInSec: number }>
  > {
    const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm']
    const IMAGE_MAX_BYTES = 10 * 1024 * 1024
    const VIDEO_MAX_BYTES = 100 * 1024 * 1024
    const presignTtl = 300
    const result: Array<{
      s3Key: string
      uploadUrl: string
      publicUrl: string
      mediaType: string
      expiresInSec: number
    }> = []
    for (const file of files) {
      if (file.mediaType === 'IMAGE') {
        if (file.sizeBytes > IMAGE_MAX_BYTES) {
          throw new AppError(400, 'Image max 10MB each', 'INVALID_REQUEST', { field: 'files' })
        }
        if (!IMAGE_MIME.includes(file.mimeType)) {
          throw new AppError(
            400,
            `Image mimeType must be one of: ${IMAGE_MIME.join(', ')}`,
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
      } else {
        if (file.sizeBytes > VIDEO_MAX_BYTES) {
          throw new AppError(400, 'Video max 100MB each', 'INVALID_REQUEST', { field: 'files' })
        }
        if (!VIDEO_MIME.includes(file.mimeType)) {
          throw new AppError(
            400,
            `Video mimeType must be one of: ${VIDEO_MIME.join(', ')}`,
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
      }
      const ext =
        file.mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ||
        file.fileName.split('.').pop() ||
        'bin'
      const s3Key = `reports/${userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
      const uploadUrl = await storageService.getPresignedPutUrl(
        s3Key,
        file.mimeType.split(';')[0]!.trim(),
        presignTtl,
      )
      const publicUrl = storageService.getCdnOrS3PublicUrl(s3Key)
      result.push({ s3Key, uploadUrl, publicUrl, mediaType: file.mediaType, expiresInSec: presignTtl })
    }
    return result
  },
}
