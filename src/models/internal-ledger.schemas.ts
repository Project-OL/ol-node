import { z } from 'zod'

/**
 * Validation is deliberately no stricter than Live-server's local path (BE-20 parity): anything
 * the local path accepts must be accepted here, or a remote-mode send fails where a local one
 * worked. Ids are checked by Postgres (uuid columns, FKs) inside the transaction, not by format
 * here; amounts are bounded by the balance check.
 */
const id = z.string().min(1).max(64)
/** Ledger key bases are built by Live-server from fixed prefixes + ids (see internalLedger.service). */
const keyBase = z.string().min(8).max(200)
const requestId = z.string().min(8).max(64)

export const GiftSendSchema = z.object({
  requestId,
  context: z.enum(['live_stream', 'video_call']),
  senderId: id,
  receiverId: id,
  giftId: id,
  // Live clamps to 1..1000; the video-call path has no upper cap (bounded by the balance).
  quantity: z.number().int().min(1).max(1_000_000),
  giftTransactionId: id,
  idemBase: keyBase.regex(/^gift(-stream)?:/),
  sessionId: id.optional(),
})

export const LuckyGiftSchema = z.object({
  requestId,
  senderId: id,
  receiverId: id.nullable(),
  giftId: id,
  count: z.number().int().min(1).max(1000),
  giftTransactionId: id,
  txKeyBase: keyBase.regex(/^lucky:/),
  rewardCoins: z.string().regex(/^\d{1,18}$/),
  category: z.string().min(1).max(64),
  // Phase 3 (additive): the caller can accept a server-drawn water_v1 result. When absent/false the
  // ledger keeps the exact legacy path and the caller's pre-drawn rewardCoins.
  supportsServerDraw: z.boolean().optional(),
})

export const CallAcceptSchema = z.object({
  requestId,
  sessionId: id,
  receiverId: id,
})

export const CallMinuteSchema = z.object({
  requestId,
  sessionId: id,
  minute: z.number().int().min(2).max(100_000),
})

export const GlobalMessageSchema = z.object({
  requestId,
  senderId: id,
  messageTxId: id,
  idemKey: keyBase.regex(/^global-msg:/),
  message: z.string().min(1).max(5000),
})
