import { z } from 'zod'

export const CreateWithdrawalSchema = z.object({
  grossPoints: z.coerce.bigint().positive(),
  paymentMethodId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  notes: z.string().max(500).optional(),
})

export const DisputeWithdrawalSchema = z.object({
  description: z.string().min(10).max(2000),
  evidenceS3Key: z.string().max(500).optional(),
})

export type CreateWithdrawalInput = z.infer<typeof CreateWithdrawalSchema>
export type DisputeWithdrawalInput = z.infer<typeof DisputeWithdrawalSchema>

export const DisputeEvidenceUrlSchema = z.object({
  mimeType: z.string().regex(/^image\/(jpeg|png|webp)$/),
})
