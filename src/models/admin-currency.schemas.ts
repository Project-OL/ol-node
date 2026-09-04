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
  /**
   * @deprecated Accepted but ignored since the treasury imputed-ledger model.
   * Revenue is now derived from unit flow at 10,000 units = $1, so recording a
   * USD figure here as well would double count. Still parsed so existing
   * clients keep working.
   */
  cashUsd: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, 'cashUsd must be a positive USD amount')
    .optional(),
  /** Promo mint: operating cost rather than a sale. */
  promotional: z.boolean().optional(),
})

export type AdminCurrencyAdjustBody = z.infer<typeof adminCurrencyAdjustBodySchema>

export const adminCurrencySupplySummaryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export type AdminCurrencySupplySummaryQuery = z.infer<typeof adminCurrencySupplySummaryQuerySchema>

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
  unitsAmount: z.string().regex(/^\d+$/).optional(),
})

export type AdminCashJournalCreateBody = z.infer<typeof adminCashJournalCreateBodySchema>

const ledgerGrainEnum = z.enum(['today', 'yesterday', 'month', 'quarter', 'year', 'custom'])

export const adminLedgerPeriodQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  grain: ledgerGrainEnum.optional(),
  at: z.string().datetime().optional(),
})

export type AdminLedgerPeriodQuery = z.infer<typeof adminLedgerPeriodQuerySchema>

export const adminLedgerBreakageInvestigateQuerySchema = z.object({
  at: z.string().datetime().optional(),
})

export type AdminLedgerBreakageInvestigateQuery = z.infer<
  typeof adminLedgerBreakageInvestigateQuerySchema
>

export const adminLedgerReconciliationInvestigateQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  grain: ledgerGrainEnum.optional(),
})

export type AdminLedgerReconciliationInvestigateQuery = z.infer<
  typeof adminLedgerReconciliationInvestigateQuerySchema
>

export const adminHouseAccountsQuerySchema = z.object({
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
})

export type AdminHouseAccountsQuery = z.infer<typeof adminHouseAccountsQuerySchema>

export const adminHouseAccountUpsertBodySchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['TREASURY', 'COMPANY_AGENCY', 'GAME_HOUSE']),
  label: z.string().max(120).optional(),
  note: z.string().max(500).optional(),
  effectiveFrom: z.string().datetime().optional(),
})

export type AdminHouseAccountUpsertBody = z.infer<typeof adminHouseAccountUpsertBodySchema>

export const adminHouseAccountDeleteBodySchema = z.object({
  /** Deactivate even though the account still holds units. */
  force: z.boolean().optional(),
})

export type AdminHouseAccountDeleteBody = z.infer<typeof adminHouseAccountDeleteBodySchema>

export const treasuryFlowClassificationEnum = z.enum(['SALE', 'PROMO', 'INTERNAL', 'WRITE_OFF'])

export const adminTreasuryFlowsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  classification: treasuryFlowClassificationEnum.optional(),
  senderUserId: z.string().uuid().optional(),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type AdminTreasuryFlowsQuery = z.infer<typeof adminTreasuryFlowsQuerySchema>

export const adminTreasuryFlowClassifyBodySchema = z.object({
  flowKind: z.enum(['COIN_TRADING_TRANSFER', 'AGENT_POINT_TRANSFER']),
  flowId: z.string().uuid(),
  /** INTERNAL is derived from a house recipient and cannot be set manually. */
  classification: z.enum(['SALE', 'PROMO', 'WRITE_OFF']),
  reason: z.string().max(500).optional(),
})

export type AdminTreasuryFlowClassifyBody = z.infer<typeof adminTreasuryFlowClassifyBodySchema>
