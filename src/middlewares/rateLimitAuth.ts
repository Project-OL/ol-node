import { FastifyRequest, FastifyReply } from 'fastify'
import { redisClient, RedisKeys } from '../config/redis'
import { AppError } from './errorHandler'

export interface UserRateLimitConfig {
  max: number
  windowMs: number
  keyFn: (req: FastifyRequest & { userId?: string }) => string
}

/**
 * Per-user rate limit using Redis. Key is built from keyFn (e.g. userId).
 * Use after authenticate. keyBuilder receives the result of keyFn(request).
 */
export function buildRateLimit(config: {
  max: number
  windowMs: number
  keyFn: (req: FastifyRequest & { userId?: string }) => string
  keyBuilder: (key: string) => string
}) {
  const { max, windowMs, keyFn, keyBuilder } = config
  const windowSec = Math.ceil(windowMs / 1000)
  return async function rateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    const userId = keyFn(request)
    if (!userId) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const key = keyBuilder(userId)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

export const rateLimitMsgSend = buildRateLimit({
  max: 30,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.msgRateLimit,
})
export const rateLimitConvCreate = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.convCreateRateLimit,
})
export const rateLimitReaction = buildRateLimit({
  max: 60,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.reactionRateLimit,
})
export const rateLimitMediaUpload = buildRateLimit({
  max: 20,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.mediaUploadRateLimit,
})
export const rateLimitBlock = buildRateLimit({
  max: 20,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.blockRateLimit,
})
export const rateLimitReport = buildRateLimit({
  max: 5,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.reportRateLimit,
})

export interface AuthRateLimitConfig {
  /** Endpoint key (e.g. 'auth.signup.send_otp') */
  endpoint: string
  /** Max requests per window */
  max: number
  /** Window in milliseconds */
  windowMs: number
}

/**
 * Returns a Fastify preHandler that enforces per-IP rate limit for an auth endpoint using Redis.
 * Uses INCR + EXPIRE; on first request in window sets TTL, then increments. If count > max, returns 429.
 */
export function createAuthRateLimit(config: AuthRateLimitConfig) {
  const { endpoint, max, windowMs } = config
  const windowSec = Math.ceil(windowMs / 1000)

  return async function authRateLimitPreHandler(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const ip = (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || request.ip || '0.0.0.0'
    const key = RedisKeys.authRateLimit(endpoint, ip)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

/**
 * Per-user rate limit for security password endpoints (must run after authenticate).
 */
export function createSecurityRateLimit(config: { endpoint: string; max: number; windowMs: number }) {
  const { endpoint, max, windowMs } = config
  const windowSec = Math.ceil(windowMs / 1000)

  return async function securityRateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    const userId = request.userId
    if (!userId) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const key = RedisKeys.securityPasswordRateLimit(endpoint, userId)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

/** Pre-configured rate limiters for auth endpoints (per prompt). */
export const authRateLimits = {
  signupSendOtp: createAuthRateLimit({ endpoint: 'auth.signup.send_otp', max: 5, windowMs: 600000 }),
  signupVerifyOtp: createAuthRateLimit({ endpoint: 'auth.signup.verify_otp', max: 10, windowMs: 600000 }),
  loginSendOtp: createAuthRateLimit({ endpoint: 'auth.login.send_otp', max: 10, windowMs: 600000 }),
  loginVerifyOtp: createAuthRateLimit({ endpoint: 'auth.login.verify_otp', max: 10, windowMs: 600000 }),
  loginPassword: createAuthRateLimit({ endpoint: 'auth.login.password', max: 10, windowMs: 600000 }),
  passwordResetSendOtp: createAuthRateLimit({ endpoint: 'auth.password.reset.send_otp', max: 5, windowMs: 600000 }),
  passwordResetConfirm: createAuthRateLimit({ endpoint: 'auth.password.reset.confirm', max: 5, windowMs: 600000 }),
  providerBind: createAuthRateLimit({ endpoint: 'auth.provider.bind', max: 5, windowMs: 86400000 }),
  providerUnbind: createAuthRateLimit({ endpoint: 'auth.provider.unbind', max: 5, windowMs: 86400000 }),
}

/** Per-user rate limiters for security password (use after authenticate). */
export const securityPasswordRateLimits = {
  getIdentifiers: createSecurityRateLimit({
    endpoint: 'security.identifiers',
    max: 60,
    windowMs: 60000,
  }),
  sendOtp: createSecurityRateLimit({
    endpoint: 'security.password.send_otp',
    max: 5,
    windowMs: 60000,
  }),
  verifyOtp: createSecurityRateLimit({
    endpoint: 'security.password.verify_otp',
    max: 10,
    windowMs: 60000,
  }),
  set: createSecurityRateLimit({
    endpoint: 'security.password.set',
    max: 5,
    windowMs: 60000,
  }),
  changeStart: createSecurityRateLimit({
    endpoint: 'security.password.change.start',
    max: 10,
    windowMs: 60000,
  }),
  changeSendOtp: createSecurityRateLimit({
    endpoint: 'security.password.change.send_otp',
    max: 5,
    windowMs: 60000,
  }),
  changeConfirm: createSecurityRateLimit({
    endpoint: 'security.password.change.confirm',
    max: 5,
    windowMs: 60000,
  }),
  reset: createSecurityRateLimit({
    endpoint: 'security.password.reset',
    max: 5,
    windowMs: 60000,
  }),
}

/**
 * Per-user rate limit for device management endpoints (must run after authenticate).
 */
export function createDeviceRateLimit(config: {
  endpoint: string
  max: number
  windowMs: number
}) {
  const { endpoint, max, windowMs } = config
  const windowSec = Math.ceil(windowMs / 1000)

  return async function deviceRateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    const userId = request.userId
    if (!userId) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const key = RedisKeys.deviceRateLimit(endpoint, userId)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

export const deviceRateLimits = {
  list: createDeviceRateLimit({ endpoint: 'device.list', max: 60, windowMs: 60000 }),
  revoke: createDeviceRateLimit({ endpoint: 'device.revoke', max: 30, windowMs: 60000 }),
  logoutAll: createDeviceRateLimit({ endpoint: 'device.logout-all', max: 5, windowMs: 60000 }),
  rename: createDeviceRateLimit({ endpoint: 'device.rename', max: 20, windowMs: 60000 }),
}

/**
 * Per-user rate limit for privacy endpoints (must run after authenticate).
 */
export function createPrivacyRateLimit(config: {
  endpoint: string
  max: number
  windowMs: number
}) {
  const { endpoint, max, windowMs } = config
  const windowSec = Math.ceil(windowMs / 1000)

  return async function privacyRateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    const userId = request.userId
    if (!userId) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const key = RedisKeys.privacyRateLimit(endpoint, userId)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

export const privacyRateLimits = {
  getSettings: createPrivacyRateLimit({
    endpoint: 'privacy.settings',
    max: 60,
    windowMs: 60000,
  }),
  toggle: createPrivacyRateLimit({
    endpoint: 'privacy.toggle',
    max: 10,
    windowMs: 60000,
  }),
}

/**
 * Per-user rate limit for account deletion endpoints (must run after authenticate).
 */
export function createAccountDeletionRateLimit(config: {
  endpoint: string
  max: number
  windowMs: number
}) {
  const { endpoint, max, windowMs } = config
  const windowSec = Math.ceil(windowMs / 1000)

  return async function accountDeletionRateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    const userId = request.userId
    if (!userId) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const key = RedisKeys.accountDeletionRateLimit(endpoint, userId)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

export const accountDeletionRateLimits = {
  scheduleDeletion: createAccountDeletionRateLimit({
    endpoint: 'account.schedule-deletion',
    max: 1,
    windowMs: 86400000, // 1/day
  }),
  cancelDeletion: createAccountDeletionRateLimit({
    endpoint: 'account.cancel-deletion',
    max: 5,
    windowMs: 86400000, // 5/day
  }),
  deletionStatus: createAccountDeletionRateLimit({
    endpoint: 'account.deletion-status',
    max: 60,
    windowMs: 60000, // 60/min
  }),
}

/**
 * Per-user rate limit for social graph endpoints (must run after authenticate).
 */
export function createSocialRateLimit(config: {
  endpoint: string
  max: number
  windowMs: number
}) {
  const { endpoint, max, windowMs } = config
  const windowSec = Math.ceil(windowMs / 1000)

  return async function socialRateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    const userId = request.userId
    if (!userId) {
      throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const key = RedisKeys.socialRateLimit(endpoint, userId)
    const count = await redisClient.incr(key)
    if (count === 1) await redisClient.expire(key, windowSec)
    if (count > max) {
      throw new AppError(
        429,
        `Too many attempts. Try again in ${windowSec} seconds.`,
        'RATE_LIMITED',
        { retryAfter: windowSec },
      )
    }
  }
}

export const socialRateLimits = {
  follow: createSocialRateLimit({
    endpoint: 'social.follow',
    max: 10,
    windowMs: 60000,
  }),
  visit: createSocialRateLimit({
    endpoint: 'social.visit',
    max: 20,
    windowMs: 60000,
  }),
  list: createSocialRateLimit({
    endpoint: 'social.list',
    max: 60,
    windowMs: 60000,
  }),
  postUploadUrl: createSocialRateLimit({
    endpoint: 'posts.upload-url',
    max: 5,
    windowMs: 600000,
  }),
  postCreate: createSocialRateLimit({
    endpoint: 'posts.create',
    max: 5,
    windowMs: 600000,
  }),
  postLike: createSocialRateLimit({
    endpoint: 'posts.like',
    max: 30,
    windowMs: 60000,
  }),
  postDelete: createSocialRateLimit({
    endpoint: 'posts.delete',
    max: 10,
    windowMs: 600000,
  }),
  tagSearch: createSocialRateLimit({
    endpoint: 'posts.tags.search',
    max: 60,
    windowMs: 60000,
  }),
}
