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
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as JwtAccessPayload
}

/** Verify access JWT for logout; accepts cryptographically valid but expired tokens. */
export function verifyAccessForLogout(token: string): JwtAccessPayload {
  try {
    return verifyAccess(token)
  } catch (e) {
    if (e instanceof TokenExpiredError) {
      return jwt.verify(token, ACCESS_SECRET, {
        algorithms: ['HS256'],
        ignoreExpiration: true,
      }) as JwtAccessPayload
    }
    throw e
  }
}

export function verifyRefresh(token: string): JwtRefreshPayload {
  return jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'] }) as JwtRefreshPayload
}
