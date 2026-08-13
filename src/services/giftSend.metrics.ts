/**
 * Lightweight gift-send metrics (replace with Prometheus when wired) — mirrors
 * src/services/auth-observability.ts's pattern.
 *
 * Tracks how often gift-send requests arrive with no client idempotencyKey
 * (the "legacy path" in gift-transaction.service.ts, which has no replay
 * protection). This is Phase 1 of the remediation plan's gift-idempotency fix
 * (docs/REMEDIATION_PLAN.md Phase 3c) — pure observability, no behavior change.
 * Once this count shows real client traffic has migrated to sending a key,
 * Phase 2 (flip to hard-reject when absent) can follow as its own, separately
 * coordinated change.
 */
export const giftSendMetrics = {
  missingIdempotencyKeyCount: 0,

  bumpMissingIdempotencyKey(): void {
    this.missingIdempotencyKeyCount += 1
  },
}
