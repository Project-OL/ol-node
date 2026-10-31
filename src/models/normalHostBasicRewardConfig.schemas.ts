import { z } from 'zod'

export const NormalHostBasicRewardConfigUpdateSchema = z.object({
  enabled: z.boolean(),
  requiredMinutes: z.number().int().min(1).max(1440),
  pointsAmount: z
    .string()
    .regex(/^[1-9]\d{0,11}$/, 'pointsAmount must be a positive integer string'),
})

export type NormalHostBasicRewardConfigUpdateInput = z.infer<
  typeof NormalHostBasicRewardConfigUpdateSchema
>
