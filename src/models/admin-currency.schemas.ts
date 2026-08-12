import { z } from 'zod'

const positiveAmountSchema = z
  .string()
  .regex(/^\d+$/, 'Amount must be a non-negative integer string')
  .refine((v) => BigInt(v) > 0n, 'Amount must be positive')

export const adminCurrencyAdjustBodySchema = z.object({
  userId: z.string().uuid(),
  currency: z.enum(['COIN', 'POINT', 'TRADING_COIN']),
  direction: z.enum(['credit', 'debit']),
  amount: positiveAmountSchema,
  description: z.string().max(500).optional(),
  idempotencyKey: z.string().max(128).optional(),
  /** Allow trading credit when target is not an agency agent. */
  forceTradingCredit: z.boolean().optional(),
})

export type AdminCurrencyAdjustBody = z.infer<typeof adminCurrencyAdjustBodySchema>

export const adminCurrencySupplySummaryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export type AdminCurrencySupplySummaryQuery = z.infer<
  typeof adminCurrencySupplySummaryQuerySchema
>

export const adminCurrencyAdjustmentsQuerySchema = z.object({
  currency: z.enum(['COIN', 'POINT', 'TRADING_COIN']).optional(),
  direction: z.enum(['credit', 'debit']).optional(),
  userId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type AdminCurrencyAdjustmentsQuery = z.infer<typeof adminCurrencyAdjustmentsQuerySchema>
