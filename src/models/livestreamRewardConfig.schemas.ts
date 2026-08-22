import { z } from 'zod'

export const LivestreamRewardConfigUpdateSchema = z
  .object({
    windowDays: z.number().int().min(1).max(30).optional(),
    pointsPerHour: z.number().int().min(1).max(1_000_000).optional(),
  })
  .refine((v) => v.windowDays !== undefined || v.pointsPerHour !== undefined, {
    message: 'Provide windowDays and/or pointsPerHour',
  })

export type LivestreamRewardConfigUpdateInput = z.infer<
  typeof LivestreamRewardConfigUpdateSchema
>
