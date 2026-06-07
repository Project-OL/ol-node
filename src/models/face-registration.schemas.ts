import { z } from 'zod'

export const faceRegistrationUploadUrlBodySchema = z.object({
  sessionId: z.string().uuid(),
  mimeType: z.enum(['video/mp4', 'video/quicktime']),
})

export const faceRegistrationVerifyBodySchema = z.object({
  sessionId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
})

export const faceRegistrationSessionCreateBodySchema = z
  .object({
    deviceMetadata: z
      .object({
        platform: z.string().max(64).optional(),
        model: z.string().max(128).optional(),
        osVersion: z.string().max(64).optional(),
        appVersion: z.string().max(32).optional(),
      })
      .optional(),
  })
  .strip()
