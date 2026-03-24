import { Redis } from 'ioredis'
import { env } from './env'

const redisOptions = {
  password: env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  retryStrategy(times: number) {
    if (times > 5) return null
    return Math.min(times * 200, 2000)
  },
}

export const redisClient = new Redis(env.REDIS_URL, redisOptions)

redisClient.on('connect', () => console.info('✅ Redis connected'))
redisClient.on('error', (err) => console.error('❌ Redis error:', err))

/** Read replica client when REDIS_READ_URL is set; use for read-only ops to reduce load on primary. */
export const redisReadClient: Redis | null = env.REDIS_READ_URL
  ? new Redis(env.REDIS_READ_URL, redisOptions)
  : null

if (redisReadClient) {
  redisReadClient.on('connect', () => console.info('✅ Redis read replica connected'))
  redisReadClient.on('error', (err) => console.error('❌ Redis read error:', err))
}

/** Client to use for read-only Redis ops (get, ping). Uses read replica when set. */
export function getRedisForRead(): Redis {
  return redisReadClient ?? redisClient
}

export const RedisKeys = {
  blacklist:      (jti: string) => `blacklist:jti:${jti}`,
  userAuthIdentifiers: (userId: string) => `user:${userId}:auth_identifiers`,
  /** Permanent VIP inventory: IDs that are reserved (no TTL). */
  vipReserved: () => 'vip:reserved',
  /** VIP pool per tier (sorted set, no TTL). */
  vipPool: (tier: string) => `vip:pool:${tier}`,
  /** VIP metadata hash per public ID (no TTL). */
  vipMeta: (publicId: bigint | string | number) => `vip:meta:${publicId}`,
  vipNextPublicId: () => 'vip:next_public_id',
  /** Permanent base publicId. Written once at registration. No TTL ever. NX on write. */
  userOriginalId: (userId: string) => `user:original_id:${userId}`,
  /** Active VIP publicId. TTL = remaining subscription seconds. When Redis drops this key the subscription has ended — fallback is automatic. */
  userActiveVipId: (userId: string) => `user:active_vip:${userId}`,
  session:        (sessionId: string) => `session:${sessionId}`,
  deviceLastActive: (deviceId: string) => `device:${deviceId}:lastActive`,
  rateLimitLogin: (identifier: string, ip: string) => `ratelimit:login:${identifier}:${ip}`,
  signupVerified: (provider: string, identifier: string) => `signup:verified:${provider}:${identifier}`,
  passwordResetToken: (resetToken: string) => `password_reset:${resetToken}`,
  emailModifyInProgress: (userId: string) => `email_modify:${userId}`,
  phoneModifyInProgress: (userId: string) => `phone_modify:${userId}`,
  /** Per-endpoint auth rate limit: ratelimit:auth:{endpoint}:{ip} */
  authRateLimit: (endpoint: string, ip: string) => `ratelimit:auth:${endpoint}:${ip}`,
  /** Per-user security password rate limit */
  securityPasswordRateLimit: (endpoint: string, userId: string) =>
    `ratelimit:security:${endpoint}:${userId}`,
  securityPasswordResetToken: (token: string) => `security:password:reset-token:${token}`,
  securityPasswordChangeToken: (token: string) => `security:password:change-token:${token}`,
  userSecurityIdentifiers: (userId: string) => `user:${userId}:security:identifiers`,
  userSecurityPasswordExists: (userId: string) => `user:${userId}:security:password:exists`,
  userSecurityPasswordLocked: (userId: string) => `user:${userId}:security:password:locked`,
  /** Device management: list of user's devices (TTL 5 min). */
  userDevices: (userId: string) => `user:${userId}:devices`,
  /** Device management: user's sessions cache invalidation. */
  userSessions: (userId: string) => `user:${userId}:sessions`,
  /** Per-user device endpoint rate limit. */
  deviceRateLimit: (endpoint: string, userId: string) => `ratelimit:device:${endpoint}:${userId}`,
  /** Privacy: full settings with descriptions (GET /settings). */
  userPrivacySettings: (userId: string) => `user:${userId}:privacy:settings`,
  /** Privacy: minimal booleans for other services. */
  userPrivacyData: (userId: string) => `user:${userId}:privacy:data`,
  /** Per-user privacy endpoint rate limit. */
  privacyRateLimit: (endpoint: string, userId: string) => `ratelimit:privacy:${endpoint}:${userId}`,
  /** Per-user account deletion rate limit. */
  accountDeletionRateLimit: (endpoint: string, userId: string) =>
    `ratelimit:account-deletion:${endpoint}:${userId}`,
  /** Deletion status cache (TTL 1h). */
  userDeletionStatus: (userId: string) => `user:${userId}:deletion-status`,
  /** Social graph counts cache (followers/following/friends). */
  socialCounts: (userId: string) => `social:counts:${userId}`,
  /** Visitor cooldown (profileId + visitorId). */
  visitorCooldown: (profileId: string, visitorId: string) =>
    `visitor:cooldown:${profileId}:${visitorId}`,
  /** Per-user social endpoint rate limit. */
  socialRateLimit: (endpoint: string, userId: string) =>
    `ratelimit:social:${endpoint}:${userId}`,
  /** User level cache. */
  userLevel: (userId: string) => `user:${userId}:level`,
  /** User settings cache (language + messaging privacy). */
  userSettings: (userId: string) => `user:${userId}:settings`,
  /** Device-linked accounts cache (accounts available on a physical device). */
  deviceLinkedAccounts: (deviceId: string) => `device:${deviceId}:linked`,
  /** Messaging: conversation cache. */
  conversation: (id: string) => `conversation:${id}`,
  /** Messaging: user's conversation list. */
  userConversations: (userId: string) => `user:${userId}:conversations`,
  /** Messaging: recent messages sorted set per conversation. */
  convMessages: (conversationId: string) => `conv:${conversationId}:messages`,
  /** Messaging: unread count per user per conversation. */
  unreadCount: (userId: string, convId: string) => `unread:${userId}:${convId}`,
  /** Messaging: user online status. */
  userOnlineStatus: (userId: string) => `online:${userId}`,
  /** Messaging: typing indicator per conversation per user. */
  userTyping: (convId: string, userId: string) => `typing:${convId}:${userId}`,
  /** Messaging: send message rate limit per user. */
  msgRateLimit: (userId: string) => `ratelimit:msg:send:${userId}`,
  /** Messaging: create conversation rate limit per user. */
  convCreateRateLimit: (userId: string) => `ratelimit:conv:create:${userId}`,
  /** Messaging: reaction rate limit per user. */
  reactionRateLimit: (userId: string) => `ratelimit:reaction:${userId}`,
  /** Messaging: media upload rate limit per user. */
  mediaUploadRateLimit: (userId: string) => `ratelimit:media:upload:${userId}`,
  /** Messaging: block rate limit per user. */
  blockRateLimit: (userId: string) => `ratelimit:block:${userId}`,
  /** Messaging: report rate limit per user. */
  reportRateLimit: (userId: string) => `ratelimit:report:${userId}`,
  /** Messaging: block list cache per user. */
  blockList: (userId: string) => `blocklist:${userId}`,
  /** Messaging: allowed sender cache (recipientId, senderId) — 60s TTL to avoid repeated follow checks. */
  allowedMessaging: (recipientId: string, senderId: string) =>
    `allowed-messaging:${recipientId}:${senderId}`,
} as const

/** TTL in seconds for user auth identifiers cache (1 hour). */
export const AUTH_IDENTIFIERS_CACHE_TTL = 3600

/** TTL in seconds for user devices list cache (5 min). */
export const USER_DEVICES_CACHE_TTL = 300

/** Messaging: recent messages sorted set TTL (2h). */
export const MSG_HOT_TTL = 60 * 60 * 2
/** Messaging: conversation list per user TTL (5m). */
export const CONV_LIST_TTL = 60 * 5
/** Messaging: online status TTL (30s, refreshed by WS heartbeat). */
export const ONLINE_STATUS_TTL = 30
/** Messaging: typing indicator TTL (5s). */
export const TYPING_TTL = 5
/** Messaging: block list per user TTL (1h). */
export const BLOCK_LIST_TTL = 60 * 60

export async function redisPipeline(
  commands: [string, ...unknown[]][],
): Promise<unknown[]> {
  const pipe = redisClient.pipeline()
  for (const [cmd, ...args] of commands) {
    (pipe as unknown as Record<string, (...a: unknown[]) => unknown>)[cmd.toLowerCase()](...args)
  }
  const results = await pipe.exec()
  if (!results) {
    throw new Error('Redis pipeline failed to execute')
  }
  const values: unknown[] = []
  for (let i = 0; i < results.length; i++) {
    const [err, result] = results[i]
    if (err) {
      throw new Error(
        `Redis pipeline command ${i + 1} (${commands[i][0]}) failed: ${(err as Error).message}`,
      )
    }
    values.push(result)
  }
  return values
}
