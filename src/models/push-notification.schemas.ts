import { z } from 'zod'

export const SetFcmTokenSchema = z.object({
  token: z.string().min(1).max(4096),
})

export const PushNotificationSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  data: z.record(z.string()).optional(),
})

export const PushBroadcastSchema = PushNotificationSchema.extend({
  userIds: z.array(z.string().uuid()).min(1).max(50_000).optional(),
  country: z.string().min(1).max(100).optional(),
})

export const ListPushUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Case-insensitive match on `users.country` (same semantics as broadcast). */
  country: z.string().min(1).max(100).optional(),
  /** Search username, publicId (digits), or name (first/last). */
  q: z.string().min(1).max(100).optional(),
  /** When true (default), only `status=active` and non-support users — matches broadcast audience. */
  activeOnly: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((v) => {
      if (v === undefined) return true
      if (typeof v === 'boolean') return v
      return v === 'true' || v === '1'
    }),
})

export const ListPushDeliveriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['SENT', 'FAILED', 'SKIPPED']).optional(),
  source: z.enum(['ADMIN_SINGLE', 'ADMIN_BROADCAST', 'TRANSACTION', 'NEW_MESSAGE']).optional(),
  campaignId: z.string().min(1).max(128).optional(),
  /** Default true — restrict to current UTC calendar day. Pass false for all-time (still paginated). */
  todayOnly: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .optional()
    .transform((v) => {
      if (v === undefined) return true
      if (typeof v === 'boolean') return v
      return v === 'true' || v === '1'
    }),
})

export type SetFcmTokenInput = z.infer<typeof SetFcmTokenSchema>
export type PushNotificationInput = z.infer<typeof PushNotificationSchema>
export type PushBroadcastInput = z.infer<typeof PushBroadcastSchema>
export type ListPushUsersQuery = z.infer<typeof ListPushUsersQuerySchema>
export type ListPushDeliveriesQuery = z.infer<typeof ListPushDeliveriesQuerySchema>
