import { z } from 'zod'

export const AdminAuthLockoutUnitSchema = z.enum(['minutes', 'hours'])

export const AdminAuthConfigUpdateSchema = z
  .object({
    failedLoginThreshold: z.number().int().min(1).max(50).optional(),
    amount: z.number().int().positive().optional(),
    unit: AdminAuthLockoutUnitSchema.optional(),
  })
  .refine(
    (v) => v.failedLoginThreshold !== undefined || (v.amount !== undefined && v.unit !== undefined),
    { message: 'Provide failedLoginThreshold and/or amount+unit' },
  )
  .refine((v) => (v.amount === undefined) === (v.unit === undefined), {
    message: 'amount and unit must be sent together',
  })

export type AdminAuthConfigUpdateInput = z.infer<typeof AdminAuthConfigUpdateSchema>
