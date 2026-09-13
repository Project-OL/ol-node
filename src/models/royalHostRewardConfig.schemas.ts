import { z } from 'zod'

const giftingTierSchema = z.object({
  threshold: z.string().regex(/^\d+$/, 'threshold must be a non-negative integer string'),
  cumulativePoints: z
    .string()
    .regex(/^\d+$/, 'cumulativePoints must be a non-negative integer string'),
})

export const RoyalHostRewardConfigUpdateSchema = z
  .object({
    weeklyHoursRequired: z.number().int().min(1).max(168).optional(),
    dailyHoursCapMinutes: z.number().int().min(1).max(1440).optional(),
    timingStep1Points: z.string().regex(/^\d+$/).optional(),
    timingStep2Points: z.string().regex(/^\d+$/).optional(),
    timingStep2EarningThreshold: z.string().regex(/^\d+$/).optional(),
    giftingTiers: z.array(giftingTierSchema).min(1).max(20).optional(),
    consecutiveMissWeeksLimit: z.number().int().min(1).max(52).optional(),
    autoRevokeEarningThreshold: z.string().regex(/^\d+$/).optional(),
  })
  .refine((v) => Object.values(v).some((val) => val !== undefined), {
    message: 'Provide at least one field to update',
  })

export type RoyalHostRewardConfigUpdateInput = z.infer<typeof RoyalHostRewardConfigUpdateSchema>
export type RoyalHostGiftingTierInput = z.infer<typeof giftingTierSchema>
