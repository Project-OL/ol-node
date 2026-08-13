import Redis from 'ioredis'
import { env } from '../config/env'
import { conversationRooms } from './conversation-rooms'
import { presenceRooms } from './presence-rooms'
import { userInboxRooms } from './user-inbox-rooms'
import { guardianRooms } from './guardian-rooms'
import { supportTicketRooms } from './support-ticket-rooms'
import WebSocket from 'ws'
import { isSocketWritable } from './send-server-frame'

/** Must match `RedisKeys.convChannel` prefix. */
const CONV_CHANNEL_PREFIX = 'msg:conv:'
/** Per-user digest channel — must be distinct from `msg:conv:`. */
const USER_INBOX_PREFIX = 'msg:user:'
/** Must match `RedisKeys.presenceChannel` prefix. */
const PRESENCE_CHANNEL_PREFIX = 'presence:user:'
/** Must match `RedisKeys.guardianWatchChannel` prefix. */
const GUARDIAN_WATCH_PREFIX = 'guardian:user:'
/** Must match `RedisKeys.supportTicketChannel` prefix. */
const SUPPORT_TICKET_PREFIX = 'msg:support_ticket:'

function conversationIdFromChannel(channel: string): string | null {
  if (!channel.startsWith(CONV_CHANNEL_PREFIX)) return null
  const id = channel.slice(CONV_CHANNEL_PREFIX.length)
  return id.length > 0 ? id : null
}

function presenceTargetUserId(channel: string): string | null {
  if (!channel.startsWith(PRESENCE_CHANNEL_PREFIX)) return null
  const id = channel.slice(PRESENCE_CHANNEL_PREFIX.length)
  return id.length > 0 ? id : null
}

function inboxTargetUserId(channel: string): string | null {
  if (!channel.startsWith(USER_INBOX_PREFIX)) return null
  const id = channel.slice(USER_INBOX_PREFIX.length)
  return id.length > 0 ? id : null
}

function guardianWatchTargetUserId(channel: string): string | null {
  if (!channel.startsWith(GUARDIAN_WATCH_PREFIX)) return null
  const id = channel.slice(GUARDIAN_WATCH_PREFIX.length)
  return id.length > 0 ? id : null
}

function supportTicketIdFromChannel(channel: string): string | null {
  if (!channel.startsWith(SUPPORT_TICKET_PREFIX)) return null
  const id = channel.slice(SUPPORT_TICKET_PREFIX.length)
  return id.length > 0 ? id : null
}

function fanoutRaw(sockets: Array<{ ws: WebSocket }>, message: string) {
  for (const rs of sockets) {
    try {
      if (isSocketWritable(rs.ws)) {
        rs.ws.send(message)
      }
    } catch {
      /* ignore broken socket */
    }
  }
}

const redisSubscriberOptions = {
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null as number | null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times: number) {
    if (times > 5) return null
    return Math.min(times * 200, 2000)
  },
}

/**
 * Dedicated Redis connection for SUBSCRIBE (must not use `redisClient` pub/sub on same connection).
 * Lazy refcount per channel matches local JOIN / JOIN_PRESENCE interest.
 */
class RedisRealtimeSubscriber {
  private client: Redis | null = null
  private readonly refCounts = new Map<string, number>()
  private started = false

  async ensureStarted(): Promise<void> {
    if (this.started) return
    this.started = true
    this.client = new Redis(env.REDIS_URL, redisSubscriberOptions)
    this.client.on('error', (err) => {
      console.error('❌ Redis subscriber error:', err)
    })
    // lazyConnect: true — connect before any SUBSCRIBE so the first JOIN is not lost.
    if (this.client.status === 'wait') {
      await this.client.connect().catch((err) => {
        console.error('❌ Redis subscriber connect failed:', err)
      })
    }
    this.client.on('message', (channel: string, message: string) => {
      const convId = conversationIdFromChannel(channel)
      if (convId) {
        const maybeAutoReply = message.includes('"isAutoReply":true')
        let parsed: { t?: string; message?: { senderId?: string; isAutoReply?: boolean } } | null =
          null
        if (maybeAutoReply) {
          try {
            parsed = JSON.parse(message) as {
              t?: string
              message?: { senderId?: string; isAutoReply?: boolean }
            }
          } catch {
            parsed = null
          }
        }
        const sockets = conversationRooms.getSockets(convId)
        for (const rs of sockets) {
          if (
            parsed?.t === 'NEW_MESSAGE' &&
            parsed.message?.isAutoReply &&
            parsed.message.senderId === rs.userId
          ) {
            continue
          }
          try {
            if (isSocketWritable(rs.ws)) {
              rs.ws.send(message)
            }
          } catch {
            /* ignore broken socket */
          }
        }
        return
      }
      const inboxUserId = inboxTargetUserId(channel)
      if (inboxUserId) {
        const sockets = userInboxRooms.getSockets(inboxUserId)
        fanoutRaw(sockets, message)
        return
      }
      const presenceUserId = presenceTargetUserId(channel)
      if (presenceUserId) {
        const sockets = presenceRooms.getSockets(presenceUserId)
        fanoutRaw(sockets, message)
        return
      }
      const guardianUserId = guardianWatchTargetUserId(channel)
      if (guardianUserId) {
        fanoutRaw(guardianRooms.getSockets(guardianUserId), message)
        return
      }
      const supportTicketId = supportTicketIdFromChannel(channel)
      if (supportTicketId) {
        fanoutRaw(supportTicketRooms.getSockets(supportTicketId), message)
      }
    })
  }

  async subscribe(channel: string): Promise<void> {
    await this.ensureStarted()
    const c = this.client!
    const n = (this.refCounts.get(channel) ?? 0) + 1
    this.refCounts.set(channel, n)
    if (n === 1) {
      await c.subscribe(channel)
    }
  }

  async unsubscribe(channel: string): Promise<void> {
    const c = this.client
    if (!c) return
    const prev = this.refCounts.get(channel) ?? 0
    const n = prev - 1
    if (n <= 0) {
      this.refCounts.delete(channel)
      await c.unsubscribe(channel).catch(() => {})
    } else {
      this.refCounts.set(channel, n)
    }
  }

  getRefCount(channel: string): number {
    return this.refCounts.get(channel) ?? 0
  }

  async stop(): Promise<void> {
    if (!this.client) return
    const c = this.client
    this.client = null
    this.refCounts.clear()
    this.started = false
    await c.quit().catch(() => {})
  }
}

export const redisConversationSubscriber = new RedisRealtimeSubscriber()
