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

export const faceProfileStatusSchema = z.enum([
  'PENDING_INDEX',
  'INDEXED',
  'FAILED',
  'REVOKED',
  'DUPLICATE_FACE',
])

export const adminListFaceProfilesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20).optional(),
  status: faceProfileStatusSchema.optional(),
  includeRevoked: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((v) => {
      if (v === undefined) return false
      if (typeof v === 'boolean') return v
      return v === 'true' || v === '1'
    }),
})

export const adminListCollectionFacesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(4096).default(100).optional(),
  nextToken: z.string().min(1).optional(),
})

export const adminRevokeFaceBodySchema = z.object({
  reason: z.string().max(500).optional(),
  /** Default true — also revokes DUPLICATE_FACE rows linked to this user. */
  revokeRelated: z.boolean().optional(),
})

export const adminListPendingDuplicatesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
})

export const adminAcceptDuplicateBodySchema = z.object({
  reason: z.string().max(500).optional(),
})
