/**
 * Suffixes for paired ledger legs that share one purchase/event idempotency base key.
 * Use the same base key for coin debit and point credit within one transaction so
 * repeat purchases (same user pair) never reuse a long-lived business row id.
 *
 * Safe flows (already event-scoped): gift send, video-call billing, store/VIP purchases
 * (client idempotencyKey), username change, coin-trading transfer, trading top-up,
 * payroll assignment payouts, withdrawal escrow/settlement, agent point transfer,
 * agency commission. Subscription renewal/grace use timestamp-scoped keys.
 * Fixed here: subscription initial purchase, guardian purchase (via ledgerHostPointsKey).
 */export const LEDGER_IDEM_SUFFIX = {
  HOST_POINTS: ':host-points',
} as const

/** Point credit idempotency key for a host-revenue leg tied to a purchase event. */
export function ledgerHostPointsKey(purchaseEventKey: string): string {
  return `${purchaseEventKey}${LEDGER_IDEM_SUFFIX.HOST_POINTS}`
}
