import { redisClient } from '../config/redis'
import { RedisKeys } from '../config/redis'
import type { ServerFrame } from '../realtime/types'

/** @deprecated Prefer publishing `ServerFrame` (`t` discriminant); retained for call-site compatibility. */
export type WsEvent =
  | { type: 'NEW_MESSAGE'; conversationId: string; message: unknown }
  | { type: 'MESSAGE_DELETED'; conversationId: string; messageId: string }
  | {
      type: 'MESSAGE_EDITED'
      conversationId: string
      messageId: string
      content: string
      editedAt: string
    }
  | {
      type: 'REACTION_ADDED'
      conversationId: string
      messageId: string
      userId: string
      emoji: string
    }
  | {
      type: 'REACTION_REMOVED'
      conversationId: string
      messageId: string
      userId: string
      emoji: string
    }
  | {
      type: 'CONV_MUTED'
      conversationId: string
      userId: string
      mutedUntil: string | null
    }

const LEGACY_SEQ_PLACEHOLDER = 0

function wsEventToServerFrame(event: WsEvent): ServerFrame {
  switch (event.type) {
    case 'NEW_MESSAGE':
      return {
        t: 'NEW_MESSAGE',
        conversationId: event.conversationId,
        message:
          typeof event.message === 'object' && event.message !== null
            ? (event.message as Record<string, unknown>)
            : { value: event.message },
        seq: LEGACY_SEQ_PLACEHOLDER,
      }
    case 'MESSAGE_DELETED':
      return {
        t: 'MESSAGE_DELETED',
        conversationId: event.conversationId,
        messageId: event.messageId,
        seq: LEGACY_SEQ_PLACEHOLDER,
      }
    case 'MESSAGE_EDITED':
      return {
        t: 'MESSAGE_EDITED',
        conversationId: event.conversationId,
        messageId: event.messageId,
        content: event.content,
        editedAt: event.editedAt,
        seq: LEGACY_SEQ_PLACEHOLDER,
      }
    case 'REACTION_ADDED':
      return {
        t: 'REACTION_ADDED',
        conversationId: event.conversationId,
        messageId: event.messageId,
        userId: event.userId,
        emoji: event.emoji,
      }
    case 'REACTION_REMOVED':
      return {
        t: 'REACTION_REMOVED',
        conversationId: event.conversationId,
        messageId: event.messageId,
        userId: event.userId,
        emoji: event.emoji,
      }
    case 'CONV_MUTED':
      return {
        t: 'CONV_MUTED',
        conversationId: event.conversationId,
        userId: event.userId,
        mutedUntil: event.mutedUntil,
      }
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

export async function publishToConversation(conversationId: string, event: WsEvent): Promise<void> {
  const frame = wsEventToServerFrame(event)
  await publishServerFrameToConversation(conversationId, frame)
}

export async function publishServerFrameToConversation(
  conversationId: string,
  frame: ServerFrame,
): Promise<void> {
  const channel = RedisKeys.convChannel(conversationId)
  const payload = JSON.stringify(frame, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
  await redisClient.publish(channel, payload)
}

/** Fan-out to sockets subscribed on `msg:user:{userId}` (same path as MESSAGE_DIGEST). */
export async function publishServerFrameToUser(userId: string, frame: ServerFrame): Promise<void> {
  const channel = RedisKeys.userInboxChannel(userId)
  const payload = JSON.stringify(frame, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
  await redisClient.publish(channel, payload)
}

/** Fan-out to JOIN_GUARDIAN watchers on `guardian:user:{targetUserId}`. */
export async function publishServerFrameToGuardianWatchers(
  targetUserId: string,
  frame: ServerFrame,
): Promise<void> {
  const channel = RedisKeys.guardianWatchChannel(targetUserId)
  const payload = JSON.stringify(frame, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
  await redisClient.publish(channel, payload)
}
