import crypto from 'crypto'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, s3Bucket } from '../config/s3'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { storageService } from './storage.service'
import type { GetUploadUrlsInput } from '../models/messaging.schemas'

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
    Array<{ s3Key: string; uploadUrl: string; mediaType: string; order: number }>
  > {
    const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
    const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm']
    const AUDIO_MIME = [
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
      'audio/mp4',
      'audio/aac',
    ]
    const IMAGE_MAX_BYTES = 10 * 1024 * 1024 // 10MB
    const VIDEO_MAX_BYTES = 100 * 1024 * 1024 // 100MB
    const AUDIO_MAX_BYTES = 25 * 1024 * 1024 // 25MB
    const FILE_MAX_BYTES = 50 * 1024 * 1024 // 50MB
    const byType = { IMAGE: 0, VIDEO: 0, AUDIO: 0, FILE: 0 }
    const result: Array<{
      s3Key: string
      uploadUrl: string
      mediaType: string
      order: number
    }> = []
    for (let i = 0; i < input.files.length; i++) {
      const file = input.files[i]
      if (file.mediaType === 'IMAGE') {
        byType.IMAGE += 1
        if (byType.IMAGE > 5) {
          throw new AppError(
            400,
            'Max 5 image items',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        if (file.sizeBytes > IMAGE_MAX_BYTES) {
          throw new AppError(
            400,
            'Image max 10MB each',
            'INVALID_REQUEST',
            { field: 'files' },
          )
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
          throw new AppError(
            400,
            'Max 5 video items',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        if (file.sizeBytes > VIDEO_MAX_BYTES) {
          throw new AppError(
            400,
            'Video max 100MB each',
            'INVALID_REQUEST',
            { field: 'files' },
          )
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
          throw new AppError(
            400,
            'Max 1 audio item',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        if (file.sizeBytes > AUDIO_MAX_BYTES) {
          throw new AppError(
            400,
            'Audio max 25MB each',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        if (!AUDIO_MIME.includes(file.mimeType)) {
          throw new AppError(
            400,
            `Audio mimeType must be one of: ${AUDIO_MIME.join(', ')}`,
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
      } else {
        byType.FILE += 1
        if (byType.FILE > 5) {
          throw new AppError(
            400,
            'Max 5 file items',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
        if (file.sizeBytes > FILE_MAX_BYTES) {
          throw new AppError(
            400,
            'File max 50MB each',
            'INVALID_REQUEST',
            { field: 'files' },
          )
        }
      }
      const ext =
        file.mimeType.split('/')[1] ||
        file.fileName.split('.').pop() ||
        'bin'
      const s3Key = `messaging/${userId}/${Date.now()}-${crypto.randomUUID()}.${ext}`
      const uploadUrl = await storageService.getPresignedPutUrl(
        s3Key,
        file.mimeType,
        300,
      )
      result.push({
        s3Key,
        uploadUrl,
        mediaType: file.mediaType,
        order: i,
      })
    }
    return result
  },

  async getReportEvidenceUploadUrls(
    userId: string,
    count: number,
  ): Promise<Array<{ s3Key: string; uploadUrl: string }>> {
    if (count < 1 || count > 5) {
      throw new AppError(
        400,
        'Count must be between 1 and 5',
        'INVALID_REQUEST',
      )
    }
    const result: Array<{ s3Key: string; uploadUrl: string }> = []
    const ts = Date.now()
    for (let i = 0; i < count; i++) {
      const s3Key = `reports/${userId}/${ts}-${i}.jpg`
      const uploadUrl = await storageService.getPresignedPutUrl(
        s3Key,
        'image/jpeg',
        300,
      )
      result.push({ s3Key, uploadUrl })
    }
    return result
  },
}
