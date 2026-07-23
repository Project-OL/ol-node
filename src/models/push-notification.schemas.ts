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

export type SetFcmTokenInput = z.infer<typeof SetFcmTokenSchema>
export type PushNotificationInput = z.infer<typeof PushNotificationSchema>
export type PushBroadcastInput = z.infer<typeof PushBroadcastSchema>
