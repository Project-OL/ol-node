import { z } from 'zod'

export const superHostTargetParamsSchema = z.object({
  targetUserId: z.string().min(1),
})

export type SuperHostTargetParams = z.infer<typeof superHostTargetParamsSchema>
