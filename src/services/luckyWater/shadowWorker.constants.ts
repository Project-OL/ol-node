/** Matches `TX_TIMEOUT_MS` in internalLedger.service (money tx max wait). */
export const LEDGER_TX_TIMEOUT_MS = 15_000

/** Extra buffer after ledger timeout before shadow tails a gift row (settled send). */
export const SHADOW_SETTLE_BUFFER_MS = 30_000

/** Only process gift_transactions with created_at older than this lag (Postgres NOW() − interval). */
export const SHADOW_SETTLE_LAG_MS = LEDGER_TX_TIMEOUT_MS + SHADOW_SETTLE_BUFFER_MS

export const LUCKY_SHADOW_CURSOR_ID = 'default'

export const SHADOW_AUDIT_IDEMPOTENCY_PREFIX = 'shadow:'

/** Max lucky gift rows per worker tick (cursor-ordered). */
export const SHADOW_WORKER_BATCH_SIZE = 50

export function shadowAuditIdempotencyKey(giftTransactionId: string): string {
  return `${SHADOW_AUDIT_IDEMPOTENCY_PREFIX}${giftTransactionId}`
}
