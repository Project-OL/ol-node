import { z } from 'zod'
import { normalizeAdminTags } from './admin-user-tags.schemas'

const genderSchema = z.enum(['male', 'female', 'other'])

const suspendStatusSchema = z.object({
  action: z.literal('suspend'),
  suspendDays: z.coerce.number().int().min(1).max(365).optional(),
  suspendedUntil: z.string().datetime().optional(),
})

const statusActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('active') }),
  suspendStatusSchema,
  z.object({ action: z.literal('ban') }),
])

export const adminUserPatchBodySchema = z
  .object({
    username: z.string().trim().min(2).max(255).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().min(8).max(32).optional(),
    gender: genderSchema.nullable().optional(),
    country: z.string().trim().max(100).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20, 'At most 20 tags allowed').optional(),
    status: statusActionSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'At least one field is required',
  })

export type AdminUserPatchBody = z.infer<typeof adminUserPatchBodySchema>

export function normalizeAdminPatchTags(tags: string[]): string[] {
  return normalizeAdminTags(tags)
}
