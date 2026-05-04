import { redisClient } from '../config/redis'

export type WsEvent =
  | { type: 'NEW_MESSAGE'; conversationId: string; message: unknown }
  | { type: 'MESSAGE_DELETED'; conversationId: string; messageId: string }
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

export async function publishToConversation(
  conversationId: string,
  event: WsEvent,
): Promise<void> {
  await redisClient.publish(
    `conv:${conversationId}:events`,
    JSON.stringify(event, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  )
}
