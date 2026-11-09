import { createHash } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { verifyAccess } from './jwt'
import { clientIp } from './client-ip'
import { normalizeIdentifierGuess } from './auth-identifier'

/**
 * SEC-18: who a rate-limit bucket belongs to.
 *
 * Indian mobile carriers put very many phones behind one public IPv4 (CGNAT), so a per-IP bucket
 * is shared by unrelated users. Logged-in requests are therefore counted per user; only requests
 * without a valid access token fall back to the IP.
 *
 * The token's signature is verified (HS256, microseconds) — never just decoded — otherwise a
 * client could put a fresh made-up userId in every request and get a fresh bucket each time.
 * Expired / invalid / admin tokens fall back to the IP bucket.
 */
export interface RateLimitSubject {
  /** Bucket key for the global limiter: `u:<userId>` or `ip:<ip>`. */
  key: string
  userId?: string
  ip: string
}

const CACHE = Symbol('rateLimitSubject')

type WithCache = FastifyRequest & { [CACHE]?: RateLimitSubject }

function bearerToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return undefined
  const token = auth.slice(7).trim()
  return token.length > 0 ? token : undefined
}

export function rateLimitSubject(request: FastifyRequest): RateLimitSubject {
  const req = request as WithCache
  const cached = req[CACHE]
  if (cached) return cached

  const ip = clientIp(request) ?? request.ip ?? '0.0.0.0'
  let userId: string | undefined
  const token = bearerToken(request)
  if (token) {
    try {
      const payload = verifyAccess(token)
      userId = payload.userId ?? payload.sub ?? undefined
    } catch {
      userId = undefined
    }
  }
  const subject: RateLimitSubject = userId
    ? { key: `u:${userId}`, userId, ip }
    : { key: `ip:${ip}`, ip }
  req[CACHE] = subject
  return subject
}

/**
 * Bucket id for a login/signup identifier (phone, email, publicId). Formatting noise is stripped so
 * `+91 98765-43210` and `+919876543210` share one bucket, then hashed: keeps phone numbers and
 * emails out of Redis key names and bounds the key length.
 */
export function identifierBucket(identifier: unknown): string | undefined {
  if (typeof identifier !== 'string') return undefined
  let id = normalizeIdentifierGuess(identifier)
  if (!id.includes('@')) id = id.replace(/[\s\-().]/g, '')
  return opaqueBucket(id)
}

/** Bucket id for an opaque value (reset token, access token): hashed as-is. */
export function opaqueBucket(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  if (!v) return undefined
  return createHash('sha256').update(v).digest('hex').slice(0, 32)
}
