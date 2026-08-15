/**
 * JSON-safe realtime payloads over WebSocket (BigInts must be stringified before JSON.stringify).
 * Phase 2 will populate real `seq` for messages; until then publishers use `0` as placeholder.
 */
export type MessageDTO = Record<string, unknown>

export type ServerFrame =
  | {
      /** Full message. JOIN room always; also on `msg:user:{userId}` for SYSTEM / NOTIFICATION / TRANSACTIONAL. Dedupe by `message.id`. */
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
      t: 'MESSAGE_EDITED'
      conversationId: string
      messageId: string
      content: string
      editedAt: string
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
      t: 'RECORDING'
      conversationId: string
      userId: string
      isRecording: boolean
    }
  | {
      t: 'READ'
      conversationId: string
      userId: string
      lastReadMessageId: string
    }
  /**
   * Thin fan-out on `msg:user:{userId}` for badge/list when not watching conv channel (Phase 7).
   * Carries a `lastMessage`-shaped preview so the client can patch its conversation list in place
   * (conversationId + message + time) without a REST round-trip.
   */
  | {
      t: 'MESSAGE_DIGEST'
      conversationId: string
      seq: number
      senderId: string
      message: {
        id: string
        type: string
        content: string | null
        createdAt: string
        isDeleted: boolean
      }
    }
  /** Server answer to RESUME — compare `afterSeq` with REST fetch (Phase 5). */
  | {
      t: 'SYNC_STATE'
      conversationId: string
      latestSeq: number
      hasGap: boolean
    }
  | {
      t: 'MESSAGE_MEDIA_UPDATE'
      conversationId: string
      messageId: string
      mediaItemId: string
      seq: number
      processingStatus: string
      transcriptionStatus: string
      waveformJson?: unknown
      durationSec?: number | null
      codec?: string | null
      bitrate?: number | null
      sampleRate?: number | null
      channels?: number | null
      /** CDN/S3 URL for progressive playback (same key as at send time). */
      streamingUrl: string
    }
  | { t: 'PRESENCE'; userId: string; online: boolean }
  | { t: 'PONG'; ts: number }
  | { t: 'GOAWAY'; reason?: string }
  /** Invalid client frame or recoverable WS error (do not close the socket). */
  | { t: 'ERROR'; code: string; message: string; details?: unknown }
  /** Per-user face registration / liveness pipeline (subscribe `msg:user:{userId}` on WS). */
  | {
      t: 'FACE_REGISTRATION'
      event:
        | 'face.registration.processing'
        | 'face.registration.liveness_passed'
        | 'face.registration.liveness_failed'
        | 'face.registration.index_pending'
        | 'face.registration.indexed'
        | 'face.registration.rejected'
      sessionId: string
      detail?: Record<string, unknown>
    }
  /**
   * Guardian purchase / rank updates for the target user.
   * - Target always receives via `msg:user:{targetUserId}` (auto on WS connect).
   * - Watchers receive via `JOIN_GUARDIAN` → Redis `guardian:user:{targetUserId}`.
   */
  | {
      t: 'GUARDIAN'
      event: 'guardian.purchased' | 'guardian.updated' | 'guardian.expired' | 'guardian.snapshot'
      targetUserId: string
      /** Current top guardian for the target (null when none). */
      currentGuardian: {
        guardianId: string
        guardianUserId: string
        displayName: string
        avatarUrl: string | null
        tier: string
        expiresAt: string
        daysRemaining: number
      } | null
      /** Present on `guardian.purchased` — the purchase that triggered this frame. */
      purchase?: {
        guardianId: string
        guardianUserId: string
        tier: string
        durationMonths: number
        coinsPaid: string
        expiresAt: string
      }
    }
  /** Admin moderation restriction applied/cleared (subscribe `msg:user:{userId}`). */
  | {
      t: 'USER_RESTRICTION'
      event: 'restriction.applied' | 'restriction.cleared'
      restriction?: Record<string, unknown>
      type?: string
      clearedCount?: number
    }
  /** Live support ticket thread (`JOIN_SUPPORT_TICKET` → `msg:support_ticket:{ticketId}`). */
  | {
      t: 'SUPPORT_TICKET_MESSAGE'
      ticketId: string
      ticketPublicId: string
      /** Assigned CSA / support admin id when present (deep-link). */
      assignedAdminId: string | null
      message: {
        id: string
        publicId: string
        senderType: 'USER' | 'SUPPORT'
        senderUserId: string | null
        content: string
        imageUrl: string | null
        isAutoReply: boolean
        createdAt: string
      }
    }
  /** Thin owner inbox digest when a support message arrives (always on `msg:user:{owner}`). */
  | {
      t: 'SUPPORT_TICKET_DIGEST'
      ticketId: string
      ticketPublicId: string
      assignedAdminId: string | null
      senderType: 'USER' | 'SUPPORT'
      preview: string
      createdAt: string
    }
  /**
   * Emitted to the ticket room when a CSA/SUPER_ADMIN resolves, rejects, or force-closes a ticket.
   * Both the user (via ticket room) and any admin watching the same room receive this frame.
   */
  | {
      t: 'SUPPORT_TICKET_STATUS_CHANGED'
      ticketId: string
      ticketPublicId: string
      /** New ticket status after the action. */
      status: 'PENDING_REVIEW' | 'CLOSED'
      /** CSA resolution outcome (set on resolve/reject; null on plain force-close). */
      resolution: 'RESOLVED' | 'REJECTED' | null
      assignedAdminId: string | null
      /** ISO timestamp of the status change. */
      changedAt: string
    }

export type ClientFrame =
  | { t: 'JOIN'; conversationId: string }
  | { t: 'LEAVE'; conversationId: string }
  | { t: 'TYPING'; conversationId: string; isTyping: boolean }
  | { t: 'RECORDING'; conversationId: string; isRecording: boolean }
  | { t: 'PING'; ts: number }
  | { t: 'READ'; conversationId: string; lastReadMessageId: string }
  | { t: 'JOIN_PRESENCE'; userIds: string[] }
  | { t: 'LEAVE_PRESENCE'; userIds: string[] }
  /** Watch guardian updates for other (or own) user profiles — receives GUARDIAN frames + snapshot. */
  | { t: 'JOIN_GUARDIAN'; userIds: string[] }
  | { t: 'LEAVE_GUARDIAN'; userIds: string[] }
  /** Join the support ticket thread room (ticket owner only). */
  | { t: 'JOIN_SUPPORT_TICKET'; ticketId: string }
  | { t: 'LEAVE_SUPPORT_TICKET'; ticketId: string }
  | {
      t: 'RESUME'
      conversations: Array<{ conversationId: string; afterSeq?: number }>
    }
