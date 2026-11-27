import { z } from 'zod'

const channel = z.enum(['EPAY', 'GOOGLE_PLAY', 'APPLE'])

export const paymentTxnListQuerySchema = z.object({
  channel: channel.optional(),
  kind: z.enum(['PURCHASE', 'REFUND', 'PAYOUT', 'PAYOUT_REVERSAL']).optional(),
  status: z.string().trim().min(1).max(20).optional(),
  userId: z.string().uuid().optional(),
  externalId: z.string().trim().min(1).max(128).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const paymentSuspectListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'CLEARED']).optional(),
  identityType: z.enum(['PHONE', 'EMAIL', 'DEVICE', 'USER']).optional(),
  userId: z.string().uuid().optional(),
  q: z.string().trim().min(1).max(255).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export const paymentSuspectPatchBodySchema = z.object({
  status: z.enum(['ACTIVE', 'CLEARED']),
  note: z.string().trim().max(2000).optional(),
})

/** Admin applies the refund policy by hand (a store refund seen in a console, a test). */
export const adminPaymentRefundBodySchema = z.object({
  channel,
  /** The PURCHASE row's externalId (Epay merchantOrderNo / store transaction id). */
  purchaseExternalId: z.string().trim().min(1).max(128),
  /** Provider refund id if known; defaults to `<purchaseExternalId>:refund`. */
  refundExternalId: z.string().trim().min(1).max(128).optional(),
  /** Partial refund amount in the purchase currency; omit for a full refund. */
  refundAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/)
    .optional(),
  reason: z.string().trim().min(3).max(500),
})

const usd = z.number().min(0).max(10_000_000)

/** Automatic Epay payouts: partial update; every field optional. */
export const autoPayoutConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxSinglePayoutUsd: usd.positive().optional(),
    userDailyCapUsd: usd.positive().optional(),
    platformDailyCapUsd: usd.positive().optional(),
    emailChangeHoldHours: z
      .number()
      .int()
      .min(0)
      .max(24 * 30)
      .optional(),
    minBalanceBufferUsd: usd.optional(),
    feeReserveUsd: usd.max(100).optional(),
  })
  .strict()

export type PaymentTxnListQuery = z.infer<typeof paymentTxnListQuerySchema>
export type PaymentSuspectListQuery = z.infer<typeof paymentSuspectListQuerySchema>
