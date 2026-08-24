import { z } from 'zod'

export const AgencyHostCooldownUnitSchema = z.enum(['hours', 'days'])

export const AgencyHostConfigUpdateSchema = z
  .object({
    amount: z.number().int().positive().optional(),
    unit: AgencyHostCooldownUnitSchema.optional(),
    rejoinCooldownHours: z.number().int().positive().optional(),
  })
  .refine(
    (v) => v.rejoinCooldownHours !== undefined || (v.amount !== undefined && v.unit !== undefined),
    { message: 'Provide rejoinCooldownHours or amount+unit' },
  )
  .refine((v) => (v.amount === undefined) === (v.unit === undefined), {
    message: 'amount and unit must be sent together',
  })

export type AgencyHostConfigUpdateInput = z.infer<typeof AgencyHostConfigUpdateSchema>
