/**
 * F5 payload fingerprint for lucky-gift idempotent replay (Phase 3).
 *
 * A clientTxId-scoped key (`lucky:{sender}:{clientTxId}`) is the replay identity. On a retry we load
 * the stored `lucky_draw_audit` row and compare this fingerprint of the *logical* send
 * (sender, gift, count, receiver). A mismatch means the same clientTxId was reused for a different
 * send -> 409, never a re-draw. Canonical JSON (fixed key order) + sha256 hex.
 */
import { createHash } from 'crypto'

export interface LuckyPayloadFingerprintInput {
  senderId: string
  giftId: string
  count: number
  receiverId: string | null
}

export function payloadFingerprint(input: LuckyPayloadFingerprintInput): string {
  const canonical = JSON.stringify({
    senderId: input.senderId,
    giftId: input.giftId,
    count: input.count,
    receiverId: input.receiverId ?? null,
  })
  return createHash('sha256').update(canonical).digest('hex')
}
