import { FastifyRequest, FastifyReply } from 'fastify'
import { redisClient, RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { AppError } from './errorHandler'
import { clientIp } from '../utils/client-ip'
import { identifierBucket, opaqueBucket, rateLimitSubject } from '../utils/rate-limit-subject'

/**
 * INCR + first-hit EXPIRE in a single Redis round trip (pipelined). `EXPIRE ... NX`
 * (Redis >= 7.0) sets the TTL only if the key has none yet, replacing the old
 * `if (count === 1) await redisClient.expire(...)` sequential round trip — this
 * preHandler runs on nearly every mutating endpoint.
 */
async function incrWithWindow(key: string, windowSec: number): Promise<number> {
  const results = await redisClient.pipeline().incr(key).expire(key, windowSec, 'NX').exec()
  return results?.[0]?.[1] as number
}

export interface UserRateLimitConfig {
  max: number
  windowMs: number
  keyFn: (req: FastifyRequest & { userId?: string }) => string
}

/**
 * Per-user rate limit using Redis. Key is built from keyFn (e.g. userId).
 * Use after authenticate. keyBuilder receives the result of keyFn(request).
 */
const noopRateLimit = async (
  _request: FastifyRequest & { userId?: string },
  _reply: FastifyReply,
): Promise<void> => {}

/** Face endpoints only — no-op when `FACE_RATE_LIMIT_DISABLED=true` (ol-dev testing). */
function buildFaceRateLimit(config: {
  max: number
  windowMs: number
  keyFn: (req: FastifyRequest & { userId?: string }) => string
  keyBuilder: (key: string) => string
}) {
  if (env.FACE_RATE_LIMIT_DISABLED) return noopRateLimit
  return buildRateLimit(config)
}

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
    const count = await incrWithWindow(key, windowSec)
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

export const rateLimitRichRead = buildRateLimit({
  max: 60,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitRichRead,
})

export const rateLimitAgencyApply = buildRateLimit({
  max: 3,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitAgencyApply,
})

export const rateLimitAgencyLeaveApply = buildRateLimit({
  max: 3,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitAgencyLeaveApply,
})

export const rateLimitAgencyPointTransfer = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitAgencyPointTransfer,
})

/** Agency dashboard reads: shared bucket — 30 req / 60s per agent. */
export const rateLimitAgencyDashboard = buildRateLimit({
  max: 30,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitAgencyDashboard,
})

export const rateLimitCtTopup = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitCtTopup,
})

export const rateLimitCtExchange = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitCtExchange,
})

export const rateLimitCtTransfer = buildRateLimit({
  max: 30,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitCtTransfer,
})

export interface AuthRateLimitConfig {
  /** Endpoint key (e.g. 'auth.signup.send_otp') */
  endpoint: string
  /**
   * Max requests per window per subject: per user when the route ran `authenticate` first, else per
   * `body[subjectField]` (phone/email/token) when configured, else per IP.
   */
  max: number
  /** Window in milliseconds */
  windowMs: number
  /**
   * SEC-18: body field that identifies who the attempt is for. Set → the limit is counted per value
   * of that field (so one phone can't be hammered from many IPs), and the IP gets the looser
   * `ipMax` instead (carrier NAT puts many real users on one IP).
   */
  subjectField?: 'identifier' | 'resetToken' | 'accessToken'
  /** SEC-18: per-IP ceiling when `subjectField` is set. Defaults to `max`. */
  ipMax?: number
}

function tooMany(windowSec: number): AppError {
  return new AppError(
    429,
    `Too many attempts. Try again in ${windowSec} seconds.`,
    'RATE_LIMITED',
    { retryAfter: windowSec },
  )
}

/**
 * Returns a Fastify preHandler that rate-limits an auth endpoint in Redis (INCR + first-hit EXPIRE).
 * SEC-18: keyed per user, per identifier (+ a looser per-IP ceiling) or per IP — see the config.
 */
export function createAuthRateLimit(config: AuthRateLimitConfig) {
  const { endpoint, max, windowMs, subjectField } = config
  const ipMax = config.ipMax ?? max
  const windowSec = Math.ceil(windowMs / 1000)

  return async function authRateLimitPreHandler(
    request: FastifyRequest & { userId?: string },
    _reply: FastifyReply,
  ): Promise<void> {
    if (request.userId) {
      const count = await incrWithWindow(
        RedisKeys.authUserRateLimit(endpoint, request.userId),
        windowSec,
      )
      if (count > max) throw tooMany(windowSec)
      return
    }

    const ip = clientIp(request) || '0.0.0.0'
    const ipKey = RedisKeys.authRateLimit(endpoint, ip)
    const body = request.body as Record<string, unknown> | null | undefined
    const raw = subjectField && body && typeof body === 'object' ? body[subjectField] : undefined
    const idHash =
      subjectField === 'identifier'
        ? identifierBucket(raw)
        : subjectField
          ? opaqueBucket(raw)
          : undefined

    if (!idHash) {
      // No subject in the body (or none configured): IP only. A missing field 400s in the route anyway.
      const count = await incrWithWindow(ipKey, windowSec)
      if (count > ipMax) throw tooMany(windowSec)
      return
    }

    const idKey = RedisKeys.authIdentifierRateLimit(endpoint, idHash)
    const results = await redisClient
      .pipeline()
      .incr(idKey)
      .expire(idKey, windowSec, 'NX')
      .incr(ipKey)
      .expire(ipKey, windowSec, 'NX')
      .exec()
    const idCount = results?.[0]?.[1] as number
    const ipCount = results?.[2]?.[1] as number
    if (idCount > max || ipCount > ipMax) throw tooMany(windowSec)
  }
}

/**
 * SEC-18: flood guard for logged-in traffic. The global limiter is per user, so N accounts on one
 * host would get N × RATE_LIMIT_MAX; this caps all logged-in requests from one IP together at
 * RATE_LIMIT_IP_FLOOD_MAX per RATE_LIMIT_TIME_WINDOW. Anonymous requests are already per IP in the
 * global limiter. Fails open on Redis errors (the global limiter still applies).
 */
export function ipFloodGuardHook(isExempt: (url: string) => boolean) {
  const windowSec = Math.ceil(env.RATE_LIMIT_TIME_WINDOW / 1000)
  return async function ipFloodGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (isExempt(request.url)) return
    const subject = rateLimitSubject(request)
    if (!subject.userId) return
    let count: number
    try {
      count = await incrWithWindow(RedisKeys.rateLimitIpFlood(subject.ip), windowSec)
    } catch {
      return
    }
    if (count > env.RATE_LIMIT_IP_FLOOD_MAX) {
      request.log.warn({ ip: subject.ip, count }, 'ip flood guard: 429')
      throw tooMany(windowSec)
    }
  }
}

/**
 * Per-user rate limit for security password endpoints (must run after authenticate).
 */
export function createSecurityRateLimit(config: {
  endpoint: string
  max: number
  windowMs: number
}) {
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
    const count = await incrWithWindow(key, windowSec)
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
 * Pre-configured rate limiters for auth endpoints. Window 10 min unless noted.
 * SEC-18: `max` is per phone/email/token; `ipMax` is the per-IP ceiling (carrier-NAT friendly, but
 * still caps SMS/email pumping from one host).
 */
export const authRateLimits = {
  signupSendOtp: createAuthRateLimit({
    endpoint: 'auth.signup.send_otp',
    max: 5,
    ipMax: 20,
    subjectField: 'identifier',
    windowMs: 600000,
  }),
  signupVerifyOtp: createAuthRateLimit({
    endpoint: 'auth.signup.verify_otp',
    max: 10,
    ipMax: 30,
    subjectField: 'identifier',
    windowMs: 600000,
  }),
  loginSendOtp: createAuthRateLimit({
    endpoint: 'auth.login.send_otp',
    max: 10,
    ipMax: 30,
    subjectField: 'identifier',
    windowMs: 600000,
  }),
  loginVerifyOtp: createAuthRateLimit({
    endpoint: 'auth.login.verify_otp',
    max: 10,
    ipMax: 30,
    subjectField: 'identifier',
    windowMs: 600000,
  }),
  loginPassword: createAuthRateLimit({
    endpoint: 'auth.login.password',
    max: 10,
    ipMax: 30,
    subjectField: 'identifier',
    windowMs: 600000,
  }),
  passwordResetSendOtp: createAuthRateLimit({
    endpoint: 'auth.password.reset.send_otp',
    max: 5,
    ipMax: 20,
    subjectField: 'identifier',
    windowMs: 600000,
  }),
  passwordResetConfirm: createAuthRateLimit({
    endpoint: 'auth.password.reset.confirm',
    max: 5,
    ipMax: 20,
    subjectField: 'resetToken',
    windowMs: 600000,
  }),
  /** Runs after `authenticate` → per user. 1-day window. */
  providerBind: createAuthRateLimit({
    endpoint: 'auth.provider.bind',
    max: 5,
    windowMs: 86400000,
  }),
  /** Runs after `authenticate` → per user. 1-day window. */
  providerUnbind: createAuthRateLimit({
    endpoint: 'auth.provider.unbind',
    max: 5,
    windowMs: 86400000,
  }),
  /** 1-min window. */
  logoutToken: createAuthRateLimit({
    endpoint: 'auth.logout.token',
    max: 30,
    ipMax: 120,
    subjectField: 'accessToken',
    windowMs: 60000,
  }),
  /** 1-min window. */
  invalidateAccessToken: createAuthRateLimit({
    endpoint: 'auth.access.invalidate',
    ipMax: 120,
    subjectField: 'accessToken',
    max: 30,
    windowMs: 60000,
  }),
}

/** Per-user rate limiters for security password (use after authenticate). */
const SECURITY_PIN_RATE_LIMIT = { max: 10, windowMs: 60_000 } as const

export const securityPasswordRateLimits = {
  getIdentifiers: createSecurityRateLimit({
    endpoint: 'security.identifiers',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  pinStatus: createSecurityRateLimit({
    endpoint: 'security.password.status',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  sendOtp: createSecurityRateLimit({
    endpoint: 'security.password.send_otp',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  verifyOtp: createSecurityRateLimit({
    endpoint: 'security.password.verify_otp',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  set: createSecurityRateLimit({
    endpoint: 'security.password.set',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  change: createSecurityRateLimit({
    endpoint: 'security.password.change',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  verify: createSecurityRateLimit({
    endpoint: 'security.password.verify',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
  reset: createSecurityRateLimit({
    endpoint: 'security.password.reset',
    ...SECURITY_PIN_RATE_LIMIT,
  }),
}

/**
 * Per-user rate limit for device management endpoints (must run after authenticate).
 */
export function createDeviceRateLimit(config: { endpoint: string; max: number; windowMs: number }) {
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
    const count = await incrWithWindow(key, windowSec)
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
 * Flush-sessions: per-user limit when JWT present; per-deviceId (or IP fallback) when unauthenticated.
 */
export async function deviceFlushSessionsRateLimit(
  request: FastifyRequest & { userId?: string },
  _reply: FastifyReply,
): Promise<void> {
  const max = 10
  const windowMs = 60000
  const windowSec = Math.ceil(windowMs / 1000)
  const endpoint = 'device.flush-sessions'

  let key: string
  const userId = request.userId
  if (userId) {
    key = RedisKeys.deviceRateLimit(endpoint, userId)
  } else {
    const body = request.body as { deviceId?: string } | undefined
    const deviceId = body?.deviceId?.trim()
    if (deviceId) {
      key = RedisKeys.deviceFlushRateLimit(deviceId)
    } else {
      const ip = clientIp(request) || '0.0.0.0'
      key = RedisKeys.authRateLimit(endpoint, ip)
    }
  }

  const count = await incrWithWindow(key, windowSec)
  if (count > max) {
    throw new AppError(
      429,
      `Too many attempts. Try again in ${windowSec} seconds.`,
      'RATE_LIMITED',
      { retryAfter: windowSec },
    )
  }
}

export const deviceRateLimits = {
  list: createDeviceRateLimit({
    endpoint: 'device.list',
    max: 60,
    windowMs: 60000,
  }),
  revoke: createDeviceRateLimit({
    endpoint: 'device.revoke',
    max: 30,
    windowMs: 60000,
  }),
  logoutAll: createDeviceRateLimit({
    endpoint: 'device.logout-all',
    max: 10,
    windowMs: 60000,
  }),
  flushSessions: deviceFlushSessionsRateLimit,
  rename: createDeviceRateLimit({
    endpoint: 'device.rename',
    max: 20,
    windowMs: 60000,
  }),
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
    const count = await incrWithWindow(key, windowSec)
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
    const count = await incrWithWindow(key, windowSec)
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
export function createSocialRateLimit(config: { endpoint: string; max: number; windowMs: number }) {
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
    const count = await incrWithWindow(key, windowSec)
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

export const coinTopupRateLimit = buildRateLimit({
  max: env.COIN_TOPUP_RATE_LIMIT_MAX,
  windowMs: env.COIN_TOPUP_RATE_LIMIT_WINDOW,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.walletRateLimit(userId, 'topup'),
})

export const withdrawRateLimit = buildRateLimit({
  max: 3,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.walletRateLimit(userId, 'withdraw'),
})

export const rateLimitWithdrawalCreate = buildRateLimit({
  max: 3,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitWithdrawalCreate,
})

export const rateLimitWithdrawalDispute = buildRateLimit({
  max: 1,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitWithdrawalDispute,
})

export const rateLimitPayrollComplete = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitPayrollComplete,
})

export const rateLimitPayrollReject = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitPayrollReject,
})

export const rateLimitPmBind = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: RedisKeys.ratelimitPmBind,
})

export const giftSendRateLimit = buildRateLimit({
  max: 50,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.giftSendRateLimit(userId),
})

/** Shared per-user throttle for authenticated mutating routes (e.g. subscriptions). */
export const perUserRateLimit = buildRateLimit({
  max: 60,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.subscriptionMutationRateLimit(userId),
})

/** GET /subscriptions/top-creators — 30 req/min per user. */
export const subscriptionTopCreatorsRateLimit = buildRateLimit({
  max: 30,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.subscriptionTopCreatorsRateLimit(userId),
})

/** GET /subscriptions/feed — 60 req/min per user. */
export const subscriptionFeedRateLimit = buildRateLimit({
  max: 60,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.subscriptionFeedRateLimit(userId),
})

/** Guardian purchase: max 5 per minute per authenticated user. */
export const guardianPurchaseRateLimit = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.guardianPurchaseRateLimit(userId),
})

/** Support ticket creation: max 5 per minute per authenticated user. */
export const supportTicketCreateRateLimit = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.supportRateLimit(userId),
})

export const storePurchaseRateLimit = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.storePurchaseRateLimit(userId),
})

export const storeRareIdPurchaseRateLimit = buildRateLimit({
  max: 10,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.storeRareIdPurchaseRateLimit(userId),
})

export const questionnaireSubmitRateLimit = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) =>
    `${r.userId ?? ''}:${String((r.params as { key?: string } | undefined)?.key ?? '')}`,
  keyBuilder: (combined) => {
    const [userId, key] = combined.split(':')
    return RedisKeys.questionnaireSubmitRateLimit(userId ?? '', key ?? '')
  },
})

export const questionnaireAdminRateLimit = buildRateLimit({
  max: 30,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.questionnaireAdminRateLimit(userId),
})

/** VIP membership purchase: max 5 per 60s per user. */
export const rateLimitVipmPurchase = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitVipmPurchase(userId),
})

/** VIP daily claim: max 5 per 60s per user. */
export const rateLimitVipmClaim = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitVipmClaim(userId),
})

/** Livestream reward claim: max 5 per 60s per user. */
export const rateLimitLivestreamRewardClaim = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitLivestreamRewardClaim(userId),
})

/** Royal Host reward claim: max 5 per 60s per user. */
export const rateLimitRoyalHostClaim = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitRoyalHostClaim(userId),
})

/** Normal Host reward claim: max 5 per 60s per user. */
export const rateLimitNormalHostClaim = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitNormalHostClaim(userId),
})

/** Normal Host basic reward claim: max 5 per 60s per user. */
export const rateLimitNormalHostBasicClaim = buildRateLimit({
  max: 5,
  windowMs: 60_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitNormalHostBasicClaim(userId),
})

export const rateLimitFaceRegister = buildFaceRateLimit({
  max: env.FACE_REGISTER_RATE_PER_HOUR,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.faceRegisterRateLimit(userId),
})

export const rateLimitFaceVerify = buildFaceRateLimit({
  max: env.FACE_VERIFY_RATE_PER_HOUR,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.faceVerifyRateLimitUser(userId),
})

export const rateLimitLivePhotoUploadUrl = buildRateLimit({
  max: env.LIVE_PHOTO_UPLOAD_URL_RATE_PER_HOUR,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitLivePhotoUploadUrl(userId),
})

export const rateLimitLivePhotoVerify = buildRateLimit({
  max: env.LIVE_PHOTO_VERIFY_RATE_PER_HOUR,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.ratelimitLivePhotoVerify(userId),
})

export const rateLimitFaceRegistrationSession = buildFaceRateLimit({
  max: env.FACE_REGISTRATION_RATE_SESSION_PER_HOUR,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.faceRegistrationSessionRate(userId),
})

export const rateLimitFaceRegistrationVerify = buildFaceRateLimit({
  max: env.FACE_REGISTRATION_RATE_VERIFY_PER_HOUR,
  windowMs: 3_600_000,
  keyFn: (r) => r.userId ?? '',
  keyBuilder: (userId) => RedisKeys.faceRegistrationVerifyRate(userId),
})

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
