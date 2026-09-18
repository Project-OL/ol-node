import { z } from 'zod'

export const SuperAdminNotificationListQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
})

export const SuperAdminNotificationMarkReadBodySchema = z.object({
  ids: z.array(z.string().uuid()).max(100).optional(),
})
