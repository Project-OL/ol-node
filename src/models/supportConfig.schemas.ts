import { z } from 'zod'

export const SupportReviewWindowUnitSchema = z.enum(['seconds', 'minutes', 'hours'])

export const SupportConfigUpdateSchema = z.object({
  amount: z.number().int().positive(),
  unit: SupportReviewWindowUnitSchema,
})

export type SupportConfigUpdateInput = z.infer<typeof SupportConfigUpdateSchema>
