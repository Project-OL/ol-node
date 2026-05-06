/**
 * JSON-safe realtime payloads over WebSocket (BigInts must be stringified before JSON.stringify).
 * Phase 2 will populate real `seq` for messages; until then publishers use `0` as placeholder.
 */
export type MessageDTO = Record<string, unknown>

export type ServerFrame =
  | {
      t: 'NEW_MESSAGE'
      conversationId: string
      message: MessageDTO
      seq: number
    }
  | {
      t: 'MESSAGE_DELETED'
      conversationId: string
      messageId: string
      seq: number
    }
  | {
      t: 'REACTION_ADDED'
      conversationId: string
      messageId: string
      emoji: string
      userId: string
    }
  | {
      t: 'REACTION_REMOVED'
      conversationId: string
      messageId: string
      emoji: string
      userId: string
    }
  | {
      t: 'CONV_MUTED'
      conversationId: string
      userId: string
      mutedUntil: string | null
    }
  | {
      t: 'TYPING'
      conversationId: string
      userId: string
      isTyping: boolean
    }
  | {
      t: 'READ'
      conversationId: string
      userId: string
      lastReadMessageId: string
    }
  /** Thin fan-out on `msg:user:{userId}` for badge/list when not watching conv channel (Phase 7). */
  | {
      t: 'MESSAGE_DIGEST'
      conversationId: string
      seq: number
      senderId: string
    }
  /** Server answer to RESUME — compare `afterSeq` with REST fetch (Phase 5). */
  | {
      t: 'SYNC_STATE'
      conversationId: string
      latestSeq: number
      hasGap: boolean
    }
  | { t: 'PRESENCE'; userId: string; online: boolean }
  | { t: 'PONG'; ts: number }
  | { t: 'GOAWAY'; reason?: string }

export type ClientFrame =
  | { t: 'JOIN'; conversationId: string }
  | { t: 'LEAVE'; conversationId: string }
  | { t: 'TYPING'; conversationId: string; isTyping: boolean }
  | { t: 'PING'; ts: number }
  | { t: 'READ'; conversationId: string; lastReadMessageId: string }
  | { t: 'JOIN_PRESENCE'; userIds: string[] }
  | { t: 'LEAVE_PRESENCE'; userIds: string[] }
  | {
      t: 'RESUME'
      conversations: Array<{ conversationId: string; afterSeq?: number }>
    }
