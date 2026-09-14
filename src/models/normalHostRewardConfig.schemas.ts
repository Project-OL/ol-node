import { z } from 'zod'

const normalHostTierSchema = z.object({
  thresholdPoints: z
    .string()
    .regex(/^\d+$/, 'thresholdPoints must be a non-negative integer string'),
  hourlyRatePoints: z
    .string()
    .regex(/^\d+$/, 'hourlyRatePoints must be a non-negative integer string'),
  hourCapHours: z.number().int().min(1).max(24),
  windowDays: z.number().int().min(1).max(90),
})

export const NormalHostRewardConfigUpdateSchema = z.object({
  tiers: z.array(normalHostTierSchema).min(1).max(30),
})

export type NormalHostRewardConfigUpdateInput = z.infer<typeof NormalHostRewardConfigUpdateSchema>
export type NormalHostTierInput = z.infer<typeof normalHostTierSchema>
