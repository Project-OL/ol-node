import { z } from 'zod'

export const accountDeletionAdminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Default open = requested and not yet cancelled or permanently deleted. */
  status: z.enum(['open', 'cancelled', 'deleted', 'all']).default('open'),
  q: z.string().trim().min(1).max(255).optional(),
  qType: z.enum(['auto', 'userId', 'publicId', 'displayId']).default('auto'),
})

export type AccountDeletionAdminListQuery = z.infer<typeof accountDeletionAdminListQuerySchema>
