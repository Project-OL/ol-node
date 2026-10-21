import jwt, { TokenExpiredError } from 'jsonwebtoken'
import { env } from '../config/env'
import type { JwtAccessPayload, JwtRefreshPayload } from '../models/types'

/** Parse env style expiry e.g. 8m, 15m, 7d into seconds (for Redis TTL alignment). */
export function parseJwtExpiresToSeconds(expiresIn: string): number {
  const m = /^(\d+)\s*([smhd])$/i.exec(expiresIn.trim())
  if (!m) return 480
  const n = Number(m[1])
  const u = m[2]!.toLowerCase()
  const mult = u === 's' ? 1 : u === 'm' ? 60 : u === 'h' ? 3600 : 86400
  return n * mult
}

const ACCESS_SECRET = env.JWT_ACCESS_SECRET
const REFRESH_SECRET = env.JWT_REFRESH_SECRET ?? env.JWT_ACCESS_SECRET

/**
 * SEC-01 rotation without logging anyone out: tokens are always signed with the current secret, and
 * verified with the current one first. Only when that fails on the SIGNATURE is the optional
 * `*_PREVIOUS` secret tried, so tokens issued before a rotation keep working during the grace period.
 * Expiry and every other error come from the current-secret check, exactly as before. With no
 * previous secret configured this is plain `jwt.verify`.
 */
export function verifyRotating<T>(
  token: string,
  current: string,
  previous: string | undefined,
  options: jwt.VerifyOptions,
): T {
  try {
    return jwt.verify(token, current, options) as T
  } catch (e) {
    if (previous && e instanceof jwt.JsonWebTokenError && e.message === 'invalid signature') {
      return jwt.verify(token, previous, options) as T
    }
    throw e
  }
}

const ACCESS_PREVIOUS = env.JWT_ACCESS_SECRET_PREVIOUS
const REFRESH_PREVIOUS = env.JWT_REFRESH_SECRET_PREVIOUS ?? env.JWT_ACCESS_SECRET_PREVIOUS

export function signAccess(
  payload: Omit<JwtAccessPayload, 'iat' | 'exp'>,
  expiresIn?: string,
): string {
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: expiresIn ?? env.JWT_ACCESS_EXPIRES_IN,
    algorithm: 'HS256',
  } as jwt.SignOptions)
}

export function signRefresh(payload: Omit<JwtRefreshPayload, 'iat' | 'exp'>): string {
  return jwt.sign(payload, REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
    algorithm: 'HS256',
  } as jwt.SignOptions)
}

export function verifyAccess(token: string): JwtAccessPayload {
  return verifyRotating<JwtAccessPayload>(token, ACCESS_SECRET, ACCESS_PREVIOUS, {
    algorithms: ['HS256'],
  })
}

/** Verify access JWT for logout; accepts cryptographically valid but expired tokens. */
export function verifyAccessForLogout(token: string): JwtAccessPayload {
  try {
    return verifyAccess(token)
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      return verifyRotating<JwtAccessPayload>(token, ACCESS_SECRET, ACCESS_PREVIOUS, {
        algorithms: ['HS256'],
        ignoreExpiration: true,
      })
    }
    throw e
  }
}

export function verifyRefresh(token: string): JwtRefreshPayload {
  return verifyRotating<JwtRefreshPayload>(token, REFRESH_SECRET, REFRESH_PREVIOUS, {
    algorithms: ['HS256'],
  })
}
