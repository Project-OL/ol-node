import { z } from 'zod'

export const adminLiveModerationKindSchema = z.enum([
  'nudity',
  'video_call',
  'user_report',
  'host_ban',
])

export const adminModerationActionSchema = z.enum(['WARNING', 'BLOCK'])

export const adminReportReasonSchema = z.enum([
  'SPAM',
  'HARASSMENT',
  'INAPPROPRIATE_CONTENT',
  'FAKE_ACCOUNT',
  'VIOLENCE',
  'OTHER',
  'GIFT_FRAUD',
  'MULTIPLE_ACCOUNT',
  'TOP_UP_FRAUD',
  'LIVE_BROADCAST_VIOLATION',
  'CHILD_SAFETY_VIOLATION',
])

export const adminReportStatusSchema = z.enum(['PENDING', 'REVIEWED', 'RESOLVED', 'DISMISSED'])

export const adminLiveModerationListQuerySchema = z.object({
  kind: adminLiveModerationKindSchema.optional(),
  userId: z.string().uuid().optional(),
  /** Filter nudity / video_call logs. Ignored for other kinds. */
  action: adminModerationActionSchema.optional(),
  /** Filter user_report rows. Ignored for other kinds. */
  reason: adminReportReasonSchema.optional(),
  status: adminReportStatusSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const adminUserLiveModerationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  action: adminModerationActionSchema.optional(),
  reason: adminReportReasonSchema.optional(),
  status: adminReportStatusSchema.optional(),
})

export type AdminLiveModerationListQuery = z.infer<typeof adminLiveModerationListQuerySchema>
export type AdminUserLiveModerationQuery = z.infer<typeof adminUserLiveModerationQuerySchema>
