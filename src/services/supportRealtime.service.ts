import { redisClient, RedisKeys } from '../config/redis'
import {
  publishServerFrameToSupportTicket,
  publishServerFrameToUser,
} from '../utils/ws-publisher'
import { pushNotificationService } from './pushNotification.service'
import type { ServerFrame } from '../realtime/types'

const WATCH_TTL_SEC = 86_400

export type SupportTicketStatusChangedInput = {
  ticketId: bigint
  ticketPublicId: string
  status: 'PENDING_REVIEW' | 'CLOSED'
  resolution: 'RESOLVED' | 'REJECTED' | null
  assignedAdminId: string | null
}

/** Emit SUPPORT_TICKET_STATUS_CHANGED to the ticket room (user + any watching admin receive it). */
export async function notifySupportTicketStatusChanged(
  input: SupportTicketStatusChangedInput,
): Promise<void> {
  const ticketId = input.ticketId.toString()
  const frame = {
    t: 'SUPPORT_TICKET_STATUS_CHANGED' as const,
    ticketId,
    ticketPublicId: input.ticketPublicId,
    status: input.status,
    resolution: input.resolution,
    assignedAdminId: input.assignedAdminId,
    changedAt: new Date().toISOString(),
  }
  await publishServerFrameToSupportTicket(ticketId, frame)
}

export type SupportMessageNotifyInput = {
  ticketId: bigint
  ticketPublicId: string
  ownerUserId: string
  assignedAdminId: string | null
  message: {
    id: bigint
    publicId: string
    senderType: 'USER' | 'SUPPORT'
    senderUserId: string | null
    content: string
    imageUrl: string | null
    isAutoReply: boolean
    createdAt: Date
  }
}

export async function markSupportTicketWatching(ticketId: string, userId: string): Promise<void> {
  const key = RedisKeys.supportTicketWatch(ticketId, userId)
  await redisClient.incr(key)
  await redisClient.expire(key, WATCH_TTL_SEC)
}

export async function unmarkSupportTicketWatching(ticketId: string, userId: string): Promise<void> {
  const key = RedisKeys.supportTicketWatch(ticketId, userId)
  const n = await redisClient.decr(key)
  if (n <= 0) {
    await redisClient.del(key)
  } else {
    await redisClient.expire(key, WATCH_TTL_SEC)
  }
}

export async function isWatchingSupportTicket(ticketId: string, userId: string): Promise<boolean> {
  const n = Number((await redisClient.get(RedisKeys.supportTicketWatch(ticketId, userId))) ?? 0)
  return n > 0
}

function previewText(content: string, hasImage: boolean): string {
  const trimmed = content.trim()
  if (trimmed) return trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed
  if (hasImage) return 'Sent an image'
  return 'New support message'
}

/**
 * Fan-out a new support ticket message to the ticket room (+ owner inbox digest).
 * FCM push to the ticket owner when a SUPPORT reply arrives and the owner is not
 * watching the ticket socket room.
 */
export async function notifySupportTicketMessage(input: SupportMessageNotifyInput): Promise<void> {
  const ticketId = input.ticketId.toString()
  const createdAt = input.message.createdAt.toISOString()
  const preview = previewText(input.message.content, Boolean(input.message.imageUrl))

  const messageFrame: ServerFrame = {
    t: 'SUPPORT_TICKET_MESSAGE',
    ticketId,
    ticketPublicId: input.ticketPublicId,
    assignedAdminId: input.assignedAdminId,
    message: {
      id: input.message.id.toString(),
      publicId: input.message.publicId,
      senderType: input.message.senderType,
      senderUserId: input.message.senderUserId,
      content: input.message.content,
      imageUrl: input.message.imageUrl,
      isAutoReply: input.message.isAutoReply,
      createdAt,
    },
  }

  const digestFrame: ServerFrame = {
    t: 'SUPPORT_TICKET_DIGEST',
    ticketId,
    ticketPublicId: input.ticketPublicId,
    assignedAdminId: input.assignedAdminId,
    senderType: input.message.senderType,
    preview,
    createdAt,
  }

  await Promise.all([
    publishServerFrameToSupportTicket(ticketId, messageFrame),
    publishServerFrameToUser(input.ownerUserId, digestFrame),
  ])

  if (input.message.senderType !== 'SUPPORT') return

  try {
    const watching = await isWatchingSupportTicket(ticketId, input.ownerUserId)
    if (watching) return

    await pushNotificationService.sendToUser(
      input.ownerUserId,
      {
        title: 'Customer support replied',
        body: preview,
        data: {
          type: 'SUPPORT_TICKET',
          ticketId,
          ticketPublicId: input.ticketPublicId,
          messageId: input.message.id.toString(),
          messagePublicId: input.message.publicId,
          customerSupportId: input.assignedAdminId ?? '',
          assignedAdminId: input.assignedAdminId ?? '',
          senderType: 'SUPPORT',
        },
      },
      { source: 'SUPPORT_TICKET', logDelivery: true },
    )
  } catch (err) {
    console.warn('[support-realtime] push failed', {
      ticketId,
      userId: input.ownerUserId,
      err,
    })
  }
}
