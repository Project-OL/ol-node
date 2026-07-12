import { z } from 'zod'

export const adminUserSearchTypeSchema = z.enum([
  'auto',
  'name',
  'userId',
  'publicId',
  'email',
  'phone',
  'deviceId',
])

export const adminUserSearchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Search query is required').max(255),
  type: adminUserSearchTypeSchema.default('auto'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  includeStore: z.coerce.boolean().optional().default(true),
})

export type AdminUserSearchType = z.infer<typeof adminUserSearchTypeSchema>
export type AdminUserSearchQuery = z.infer<typeof adminUserSearchQuerySchema>
