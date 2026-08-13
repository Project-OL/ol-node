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

/** Publish one outbox row to Redis and mark published (at-least-once safe). */
export async function publishMessageOutboxRow(outboxId: bigint): Promise<void> {
  const row = await prisma.messageOutbox.findUnique({
    where: { id: outboxId },
  })
  if (!row || row.publishedAt) return

  const payloadStr =
    typeof row.payload === 'string'
      ? row.payload
      : JSON.stringify(row.payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))

  await redisClient.publish(RedisKeys.convChannel(row.conversationId), payloadStr)

  const parsed = JSON.parse(payloadStr) as {
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
    const members = await prisma.conversationMember.findMany({
      where: { conversationId: row.conversationId, isDeleted: false },
      select: { userId: true, isMuted: true, mutedUntil: true },
    })
    const msg = parsed.message
    const digestStr = JSON.stringify({
      t: 'MESSAGE_DIGEST',
      conversationId: row.conversationId,
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
    for (const m of members) {
      if (m.userId === parsed.message.senderId) continue
      digestPipe.publish(RedisKeys.userInboxChannel(m.userId), digestStr)
    }
    if (digestPipe.length > 0) await digestPipe.exec()

    await maybePushNewMessageNotifications({
      conversationId: row.conversationId,
      senderId: parsed.message.senderId,
      message: parsed.message,
      members,
    })
  }

  await prisma.messageOutbox.update({
    where: { id: outboxId },
    data: { publishedAt: new Date() },
  })
}

async function maybePushNewMessageNotifications(params: {
  conversationId: string
  senderId: string
  message: {
    id?: string
    type?: string
    content?: string | null
    isDeleted?: boolean
  }
  members: Array<{ userId: string; isMuted: boolean; mutedUntil: Date | null }>
}): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    select: { type: true },
  })
  if (!conversation || !PUSHABLE_CONVERSATION_TYPES.has(conversation.type)) return

  const recipients = params.members.filter(
    (m) => m.userId !== params.senderId && !isConversationMuted(m),
  )
  if (recipients.length === 0) return

  const sender = await prisma.user.findUnique({
    where: { id: params.senderId },
    select: { firstName: true, lastName: true, username: true },
  })
  const title = sender ? buildUserDisplayName(sender) : 'New message'
  const body = messagePushBody(params.message)
  const data: Record<string, string> = {
    type: 'NEW_MESSAGE',
    conversationId: params.conversationId,
    conversationType: conversation.type,
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
