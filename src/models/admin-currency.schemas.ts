import { z } from 'zod'

const positiveAmountSchema = z
  .string()
  .regex(/^\d+$/, 'Amount must be a non-negative integer string')
  .refine((v) => BigInt(v) > 0n, 'Amount must be positive')

export const adminCurrencyAdjustBodySchema = z
  .object({
    userId: z.string().uuid(),
    currency: z.enum(['COIN', 'POINT', 'TRADING_COIN']),
    direction: z.enum(['credit', 'debit']),
    amount: positiveAmountSchema,
    description: z.string().max(500).optional(),
    idempotencyKey: z.string().max(128).optional(),
    /** Allow trading credit when target is not an agency agent. */
    forceTradingCredit: z.boolean().optional(),
    /**
     * USD received off-system for this mint. Required when crediting TRADING_COIN
     * unless `promotional` is true.
     */
    cashUsd: z
      .string()
      .regex(/^\d+(\.\d{1,4})?$/, 'cashUsd must be a positive USD amount')
      .optional(),
    /** Promo mint with no cash-in; counted as operating cost, not capital. */
    promotional: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const promo = val.promotional === true
    const hasCash = val.cashUsd != null && val.cashUsd.length > 0 && Number(val.cashUsd) > 0
    if (val.direction === 'credit' && val.currency === 'TRADING_COIN' && !promo && !hasCash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cashUsd'],
        message: 'cashUsd is required when crediting trading coins (or set promotional=true)',
      })
    }
    if (promo && hasCash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promotional'],
        message: 'Promotional mint cannot include cashUsd',
      })
    }
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

export const adminCashJournalQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  reason: z.enum(['AGENCY_TRADING_PURCHASE', 'EPAY_PAYOUT', 'PAYROLL_TAKEOVER_PAYOUT']).optional(),
  direction: z.enum(['IN', 'OUT']).optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type AdminCashJournalQuery = z.infer<typeof adminCashJournalQuerySchema>

export const adminCashJournalCreateBodySchema = z.object({
  direction: z.enum(['IN', 'OUT']),
  reason: z.enum(['AGENCY_TRADING_PURCHASE', 'EPAY_PAYOUT', 'PAYROLL_TAKEOVER_PAYOUT']),
  amountUsd: z.string().regex(/^\d+(\.\d{1,4})?$/, 'amountUsd must be a positive USD amount'),
  counterpartyUserId: z.string().uuid().optional(),
  ledgerRefId: z.string().max(255).optional(),
  withdrawalId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
  unitsAmount: z
    .string()
    .regex(/^\d+$/)
    .optional(),
})

export type AdminCashJournalCreateBody = z.infer<typeof adminCashJournalCreateBodySchema>

export const adminLedgerPeriodQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  grain: z.enum(['month', 'quarter', 'year', 'custom']).optional(),
  at: z.string().datetime().optional(),
})

export type AdminLedgerPeriodQuery = z.infer<typeof adminLedgerPeriodQuerySchema>
