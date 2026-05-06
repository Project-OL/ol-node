import { z } from 'zod'

export const faceActionBodySchema = z.object({
  s3Key: z.string().min(1),
  clientRequestId: z.string().uuid(),
})

export const livenessSessionResponseSchema = z.object({
  sessionId: z.string().min(1),
  region: z.string().min(1),
  expiresAtIso: z.string().datetime(),
})

export const uploadUrlResponseSchema = z.object({
  uploadUrl: z.string().url(),
  s3Key: z.string().min(1),
  expiresInSec: z.number().int().positive(),
  clientRequestId: z.string().uuid(),
})

export type FaceActionBody = z.infer<typeof faceActionBodySchema>

