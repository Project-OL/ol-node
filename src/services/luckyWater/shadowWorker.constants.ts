/**
 * Shadow settle lag must cover the worst-case gap between `gift_transactions.created_at`
 * (Postgres DEFAULT now() at BEGIN of the money tx) and commit.
 *
 * Production lucky path does NOT set createdAt in app code (DB default). Inside one attempt:
 *   maxWait (connection acquire) + TX_TIMEOUT_MS (interactive tx timeout).
 * Retries start a new transaction → new created_at; no extra multiplier needed.
 *
 * Derived (not a literal 45s): timeout + maxWait + buffer.
 */
export const LEDGER_TX_TIMEOUT_MS = 15_000
/** Matches `maxWait` on `prisma.$transaction` in internalLedger.runMoneyTx. */
export const LEDGER_TX_MAX_WAIT_MS = 10_000
export const SHADOW_SETTLE_BUFFER_MS = 30_000

export const SHADOW_SETTLE_LAG_MS =
  LEDGER_TX_TIMEOUT_MS + LEDGER_TX_MAX_WAIT_MS + SHADOW_SETTLE_BUFFER_MS

export const LUCKY_SHADOW_CURSOR_ID = 'default'

export const SHADOW_AUDIT_IDEMPOTENCY_PREFIX = 'shadow:'

/** Max lucky gift rows per worker tick (cursor-ordered). */
export const SHADOW_WORKER_BATCH_SIZE = 50

export function shadowAuditIdempotencyKey(giftTransactionId: string): string {
  return `${SHADOW_AUDIT_IDEMPOTENCY_PREFIX}${giftTransactionId}`
}
