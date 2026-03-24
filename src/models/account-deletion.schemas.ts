import { z } from 'zod'

export const scheduleDeletionSchema = z.object({
  securityPassword: z.string().min(1, 'Security password required'),
  reason: z.string().max(500, 'Reason too long').optional(),
})

export const cancelDeletionSchema = z.object({
  securityPassword: z.string().min(1, 'Security password required'),
})

export type ScheduleDeletionBody = z.infer<typeof scheduleDeletionSchema>
export type CancelDeletionBody = z.infer<typeof cancelDeletionSchema>
