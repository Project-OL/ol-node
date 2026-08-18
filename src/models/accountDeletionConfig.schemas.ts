import { z } from 'zod'

export const AccountDeletionConfigUpdateSchema = z
  .object({
    gracePeriodDays: z.number().int().min(1).max(365).optional(),
    deletionPeriodDays: z.number().int().min(1).max(365).optional(),
  })
  .refine((v) => v.gracePeriodDays !== undefined || v.deletionPeriodDays !== undefined, {
    message: 'Provide gracePeriodDays and/or deletionPeriodDays',
  })

export type AccountDeletionConfigUpdateInput = z.infer<typeof AccountDeletionConfigUpdateSchema>
