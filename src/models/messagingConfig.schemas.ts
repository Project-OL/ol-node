import { z } from 'zod'

export const MessagingActionWindowUnitSchema = z.enum(['minutes', 'hours'])

export const MessagingConfigUpdateSchema = z.object({
  amount: z.number().int().positive(),
  unit: MessagingActionWindowUnitSchema,
})

export type MessagingConfigUpdateInput = z.infer<typeof MessagingConfigUpdateSchema>
