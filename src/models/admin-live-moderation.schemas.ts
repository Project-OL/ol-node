import { z } from 'zod'

export const adminLiveModerationKindSchema = z.enum([
  'nudity',
  'video_call',
  'user_report',
  'host_ban',
])

export const adminLiveModerationListQuerySchema = z.object({
  kind: adminLiveModerationKindSchema.optional(),
  userId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const adminUserLiveModerationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export type AdminLiveModerationListQuery = z.infer<typeof adminLiveModerationListQuerySchema>
export type AdminUserLiveModerationQuery = z.infer<typeof adminUserLiveModerationQuerySchema>
