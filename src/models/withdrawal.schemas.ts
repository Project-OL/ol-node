import { z } from 'zod'
import { grossPointsFromUsd } from '../utils/withdrawal-amount'

const withdrawalAmountFields = {
  grossPoints: z.coerce.bigint().positive().optional(),
  amountUsd: z.coerce.number().positive().optional(),
  paymentMethodId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  notes: z.string().max(500).optional(),
}

function resolveGrossPoints(data: {
  grossPoints?: bigint
  amountUsd?: number
}): bigint {
  if (data.amountUsd != null) {
    return grossPointsFromUsd(data.amountUsd)
  }
  if (data.grossPoints != null) {
    return data.grossPoints
  }
  throw new z.ZodError([
    {
      code: 'custom',
      message: 'Provide amountUsd or grossPoints',
      path: ['amountUsd'],
    },
  ])
}

export const CreateWithdrawalSchema = z
  .object(withdrawalAmountFields)
  .transform((data) => ({
    grossPoints: resolveGrossPoints(data),
    paymentMethodId: data.paymentMethodId,
    idempotencyKey: data.idempotencyKey,
    notes: data.notes,
  }))

export const DisputeWithdrawalSchema = z.object({
  description: z.string().min(10).max(2000),
  evidenceS3Key: z.string().max(500).optional(),
})

export type CreateWithdrawalInput = z.infer<typeof CreateWithdrawalSchema>
export type DisputeWithdrawalInput = z.infer<typeof DisputeWithdrawalSchema>

export const DisputeEvidenceUrlSchema = z.object({
  mimeType: z.string().regex(/^image\/(jpeg|png|webp)$/),
})
