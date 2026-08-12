import { z } from 'zod'

export const adminActivityListQuerySchema = z.object({
  adminUserId: z.string().uuid().optional(),
  targetUserId: z.string().uuid().optional(),
  actionType: z.string().min(1).max(100).optional(),
  ipAddress: z.string().min(1).max(45).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})

export type AdminActivityListQuery = z.infer<typeof adminActivityListQuerySchema>
