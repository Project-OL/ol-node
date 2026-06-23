import { z } from 'zod'
import { passwordSchema } from './schemas'

export const adminPasswordResetBodySchema = z.object({
  newPassword: passwordSchema.optional(),
})

export const adminFaceRevokeBodySchema = z.object({
  reason: z.string().max(500).optional(),
  revokeRelated: z.boolean().optional(),
})

export const adminDeviceBanBodySchema = z.object({
  deviceId: z.string().min(1).max(255).optional(),
  reason: z.string().max(500).optional(),
})
