import Redis from 'ioredis'
import { env } from '../config/env'
import { conversationRooms } from './conversation-rooms'
import { presenceRooms } from './presence-rooms'
import { userInboxRooms } from './user-inbox-rooms'
import WebSocket from 'ws'

/** Must match `RedisKeys.convChannel` prefix. */
const CONV_CHANNEL_PREFIX = 'msg:conv:'
/** Per-user digest channel — must be distinct from `msg:conv:`. */
const USER_INBOX_PREFIX = 'msg:user:'
/** Must match `RedisKeys.presenceChannel` prefix. */
const PRESENCE_CHANNEL_PREFIX = 'presence:user:'

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
    this.client.on('message', (channel: string, message: string) => {
      const convId = conversationIdFromChannel(channel)
      if (convId) {
        const sockets = conversationRooms.getSockets(convId)
        for (const rs of sockets) {
          try {
            if (rs.ws.readyState === WebSocket.OPEN) {
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
        for (const rs of sockets) {
          try {
            if (rs.ws.readyState === WebSocket.OPEN) {
              rs.ws.send(message)
            }
          } catch {
            /* ignore broken socket */
          }
        }
        return
      }
      const presenceUserId = presenceTargetUserId(channel)
      if (presenceUserId) {
        const sockets = presenceRooms.getSockets(presenceUserId)
        for (const rs of sockets) {
          try {
            if (rs.ws.readyState === WebSocket.OPEN) {
              rs.ws.send(message)
            }
          } catch {
            /* ignore broken socket */
          }
        }
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
