import { z } from 'zod'

const id = z.string().min(1).max(64)
const uuid = z.string().uuid()
/** Ledger key bases are built by Live-server from fixed prefixes + ids (see internalLedger.service). */
const keyBase = z.string().min(8).max(200)
const requestId = z.string().uuid()

export const GiftSendSchema = z.object({
  requestId,
  context: z.enum(['live_stream', 'video_call']),
  senderId: uuid,
  receiverId: uuid,
  giftId: uuid,
  quantity: z.number().int().min(1).max(10_000),
  giftTransactionId: uuid,
  idemBase: keyBase.regex(/^gift(-stream)?:/),
  sessionId: id.optional(),
})

export const LuckyGiftSchema = z.object({
  requestId,
  senderId: uuid,
  receiverId: uuid.nullable(),
  giftId: uuid,
  count: z.number().int().min(1).max(1000),
  giftTransactionId: uuid,
  txKeyBase: keyBase.regex(/^lucky:/),
  rewardCoins: z.string().regex(/^\d{1,18}$/),
  category: z.string().min(1).max(64),
})

export const CallAcceptSchema = z.object({
  requestId,
  sessionId: id,
  receiverId: uuid,
})

export const CallMinuteSchema = z.object({
  requestId,
  sessionId: id,
  minute: z.number().int().min(2).max(100_000),
})

export const GlobalMessageSchema = z.object({
  requestId,
  senderId: uuid,
  messageTxId: uuid,
  idemKey: keyBase.regex(/^global-msg:/),
  message: z.string().min(1).max(5000),
})
