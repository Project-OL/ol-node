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

export const adminTransactionRevertBodySchema = z.object({
  reason: z.string().min(1).max(1000),
  idempotencyKey: z.string().min(1).max(128).optional(),
})

export type AdminTransactionRevertBody = z.infer<typeof adminTransactionRevertBodySchema>
