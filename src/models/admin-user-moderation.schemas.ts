import { z } from 'zod'
import { passwordSchema } from './schemas'
import { securityPinSchema } from './security-password.schemas'

export const adminPasswordResetBodySchema = z.object({
  newPassword: passwordSchema.optional(),
})

/** Admin set/overwrite security PIN (4–8 digits). Overwrites any existing PIN and clears lockout. */
export const adminSecurityPasswordSetBodySchema = z.object({
  pin: securityPinSchema,
})

export const adminFaceRevokeBodySchema = z.object({
  reason: z.string().max(500).optional(),
  revokeRelated: z.boolean().optional(),
})

export const adminFaceUploadUrlBodySchema = z.object({
  mimeType: z
    .enum(['image/jpeg', 'image/jpg', 'image/png'])
    .optional()
    .default('image/jpeg'),
})

export const adminFaceIndexBodySchema = z.object({
  s3Key: z.string().min(1).max(512),
  reason: z.string().max(500).optional(),
  /** When true, replaces an existing INDEXED profile (DeleteFaces then re-index). Default false. */
  replaceExisting: z.boolean().optional().default(false),
})

export const adminLivePhotoRemoveBodySchema = z.object({
  reason: z.string().max(500).optional(),
})

export const adminDeviceBanBodySchema = z.object({
  deviceId: z.string().min(1).max(255).optional(),
  reason: z.string().max(500).optional(),
})
