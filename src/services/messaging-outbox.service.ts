import { prisma } from '../config/database'
import { redisClient } from '../config/redis'
import { RedisKeys } from '../config/redis'
import { enqueueMessageOutboxPublish } from '../queues/messaging.queue'
import { pushNotificationService } from './pushNotification.service'
import { buildUserDisplayName } from '../utils/user-display'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'messaging-outbox' })

const PUSHABLE_CONVERSATION_TYPES = new Set(['DIRECT', 'GROUP'])

function isConversationMuted(member: {
  isMuted: boolean
  mutedUntil: Date | null
}): boolean {
  if (!member.isMuted) return false
  if (member.mutedUntil == null) return true
  return member.mutedUntil.getTime() > Date.now()
}

function messagePushBody(message: {
  type?: string
  content?: string | null
  isDeleted?: boolean
}): string {
  if (message.isDeleted) return 'Message deleted'
  switch (message.type) {
    case 'IMAGE':
      return 'Sent a photo'
    case 'VIDEO':
      return 'Sent a video'
    case 'AUDIO':
      return 'Sent a voice message'
    case 'GIFT':
      return 'Sent a gift'
    case 'TEXT_COINS':
      return message.content?.trim() || 'Sent coins'
    default:
      return message.content?.trim().slice(0, 100) || 'New message'
  }
}

export type OutboxMember = { userId: string; isMuted: boolean; mutedUntil: Date | null }
export type OutboxSender = { firstName: string | null; lastName: string | null; username: string }

/**
 * Core publish logic: Redis fan-out (conversation channel + per-member digest)
 * + push notifications + mark-published. Takes conversation members / type /
 * sender as plain params rather than fetching them, so a caller that already
 * has this data in memory (the inline message-send fast path) doesn't pay for
 * a redundant DB round trip; a caller that doesn't (queue job / stale sweep)
 * fetches first and passes it in — see publishMessageOutboxRow below.
 */
async function publishOutboxPayload(params: {
  outboxId: bigint
  conversationId: string
  payloadStr: string
  members: OutboxMember[]
  conversationType: string
  sender: OutboxSender | null
}): Promise<void> {
  await redisClient.publish(RedisKeys.convChannel(params.conversationId), params.payloadStr)

  const parsed = JSON.parse(params.payloadStr) as {
    t?: string
    seq?: number
    message?: {
      id?: string
      senderId?: string
      type?: string
      content?: string | null
      createdAt?: string
      isDeleted?: boolean
    }
  }
  if (parsed.t === 'NEW_MESSAGE' && parsed.message?.senderId && parsed.seq !== undefined) {
    const msg = parsed.message
    const digestStr = JSON.stringify({
      t: 'MESSAGE_DIGEST',
      conversationId: params.conversationId,
      seq: parsed.seq,
      senderId: msg.senderId,
      message: {
        id: msg.id,
        type: msg.type,
        content: typeof msg.content === 'string' ? msg.content.slice(0, 100) : (msg.content ?? null),
        createdAt: msg.createdAt,
        isDeleted: msg.isDeleted ?? false,
      },
    })
    const digestPipe = redisClient.pipeline()
    for (const m of params.members) {
      if (m.userId === msg.senderId) continue
      digestPipe.publish(RedisKeys.userInboxChannel(m.userId), digestStr)
    }
    if (digestPipe.length > 0) await digestPipe.exec()

    await maybePushNewMessageNotifications({
      conversationId: params.conversationId,
      conversationType: params.conversationType,
      senderId: parsed.message.senderId,
      sender: params.sender,
      message: msg,
      members: params.members,
    })
  }

  await prisma.messageOutbox.update({
    where: { id: params.outboxId },
    data: { publishedAt: new Date() },
  })
}

/** Publish one outbox row to Redis and mark published (at-least-once safe).
 * Used by the queue-job and stale-sweep paths, which only ever have an
 * outboxId — fetches members/conversation-type/sender before delegating to
 * publishOutboxPayload. See publishMessageOutboxRowInline for the
 * same-request fast path that already has this data in memory. */
export async function publishMessageOutboxRow(outboxId: bigint): Promise<void> {
  const row = await prisma.messageOutbox.findUnique({
    where: { id: outboxId },
  })
  if (!row || row.publishedAt) return

  const payloadStr =
    typeof row.payload === 'string'
      ? row.payload
      : JSON.stringify(row.payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

  const parsed = JSON.parse(payloadStr) as {
    t?: string
    seq?: number
    message?: { senderId?: string }
  }

  let members: OutboxMember[] = []
  let conversationType = ''
  let sender: OutboxSender | null = null
  if (parsed.t === 'NEW_MESSAGE' && parsed.message?.senderId && parsed.seq !== undefined) {
    const senderId = parsed.message.senderId
    ;[members, conversationType, sender] = await Promise.all([
      prisma.conversationMember.findMany({
        where: { conversationId: row.conversationId, isDeleted: false },
        select: { userId: true, isMuted: true, mutedUntil: true },
      }),
      prisma.conversation
        .findUnique({ where: { id: row.conversationId }, select: { type: true } })
        .then((c) => c?.type ?? ''),
      prisma.user.findUnique({
        where: { id: senderId },
        select: { firstName: true, lastName: true, username: true },
      }),
    ])
  }

  await publishOutboxPayload({
    outboxId,
    conversationId: row.conversationId,
    payloadStr,
    members,
    conversationType,
    sender,
  })
}

/**
 * Fast path for the synchronous message-send request: the caller already has
 * the conversation's members (with mute status), type, and sender profile in
 * memory from moments earlier in the same request (conversationRepository
 * .findConversationById), so this skips all four of publishMessageOutboxRow's
 * Postgres reads and publishes directly.
 */
export async function publishMessageOutboxRowInline(params: {
  outboxId: bigint
  conversationId: string
  payload: Record<string, unknown>
  members: OutboxMember[]
  conversationType: string
  sender: OutboxSender | null
}): Promise<void> {
  const payloadStr = JSON.stringify(params.payload, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  )
  await publishOutboxPayload({
    outboxId: params.outboxId,
    conversationId: params.conversationId,
    payloadStr,
    members: params.members,
    conversationType: params.conversationType,
    sender: params.sender,
  })
}

async function maybePushNewMessageNotifications(params: {
  conversationId: string
  conversationType: string
  senderId: string
  sender: OutboxSender | null
  message: {
    id?: string
    type?: string
    content?: string | null
    isDeleted?: boolean
  }
  members: OutboxMember[]
}): Promise<void> {
  if (!PUSHABLE_CONVERSATION_TYPES.has(params.conversationType)) return

  const recipients = params.members.filter(
    (m) => m.userId !== params.senderId && !isConversationMuted(m),
  )
  if (recipients.length === 0) return

  const title = params.sender ? buildUserDisplayName(params.sender) : 'New message'
  const body = messagePushBody(params.message)
  const data: Record<string, string> = {
    type: 'NEW_MESSAGE',
    conversationId: params.conversationId,
    conversationType: params.conversationType,
    senderId: params.senderId,
  }
  if (params.message.id) data.messageId = params.message.id
  if (params.message.type) data.messageType = params.message.type

  await Promise.all(
    recipients.map(async (r) => {
      try {
        await pushNotificationService.sendToUser(
          r.userId,
          { title, body, data },
          { source: 'NEW_MESSAGE' },
        )
      } catch (err) {
        log.warn(
          { err, userId: r.userId, conversationId: params.conversationId },
          'new message push failed',
        )
      }
    }),
  )
}

/** Rows older than 10s still unpublished — enqueue retry jobs (crash between publish + UPDATE). */
export async function sweepStaleMessageOutbox(): Promise<void> {
  const cutoff = new Date(Date.now() - 10_000)
  const stale = await prisma.messageOutbox.findMany({
    where: {
      publishedAt: null,
      createdAt: { lt: cutoff },
    },
    take: 200,
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  for (const r of stale) {
    await enqueueMessageOutboxPublish(r.id)
  }
}
