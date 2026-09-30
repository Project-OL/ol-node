import { z } from 'zod'

const optionalUuid = z.string().uuid().optional()
const optionalId = z.string().min(1).max(128).optional()

/** Shared list filters — every endpoint accepts ID search + date window. */
export const adminTransactionsListQuerySchema = z.object({
  /** Exact ledger / row id (UUID or cuid depending on resource). */
  id: optionalId,
  /** Alias for `id` on ledger lists. */
  ledgerEntryId: optionalUuid,
  /** Gift / store / VIP / subscription / trading-transfer row id. */
  transactionId: optionalId,
  giftTransactionId: optionalUuid,
  transferId: optionalUuid,
  purchaseId: optionalId,
  subscriptionId: optionalId,
  storePurchaseId: optionalUuid,
  vipPurchaseId: optionalUuid,
  /** Party filters */
  userId: optionalUuid,
  senderUserId: optionalUuid,
  receiverUserId: optionalUuid,
  counterpartyId: optionalUuid,
  /** Resolve user by public / display id (digits). */
  publicId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .transform((v) => (v ? BigInt(v) : undefined)),
  /** Free-text id search: tries UUID id, then publicId digits. */
  q: z.string().min(1).max(128).optional(),
  types: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v == null) return undefined
      return Array.isArray(v)
        ? v
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    }),
  direction: z.enum(['credit', 'debit']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type AdminTransactionsListQuery = z.infer<typeof adminTransactionsListQuerySchema>

export const adminPlatformProfitSummaryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})

export type AdminPlatformProfitSummaryQuery = z.infer<typeof adminPlatformProfitSummaryQuerySchema>

export const adminTransactionRevertBodySchema = z
  .object({
    /** Required unless `dryRun` (a preview runs before the admin has typed a reason). */
    reason: z.string().trim().max(1000).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    /**
     * `full` (default): all-or-nothing, 402 if the receiver is short.
     * `force` (SUPER_ADMIN only): recover what the receiver still has; the rest is recorded as
     * shortfall and the transaction counts as reverted (final).
     */
    mode: z.enum(['full', 'force']).optional(),
    /** Preview only: run the checks and return receiver balance / recoverable / shortfall. */
    dryRun: z.boolean().optional(),
  })
  .refine((b) => b.dryRun === true || (b.reason != null && b.reason.length > 0), {
    message: 'reason is required',
    path: ['reason'],
  })

export type AdminTransactionRevertBody = z.infer<typeof adminTransactionRevertBodySchema>
