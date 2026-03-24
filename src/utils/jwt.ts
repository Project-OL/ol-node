import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import type { JwtAccessPayload, JwtRefreshPayload } from '../models/types'

const ACCESS_SECRET = env.JWT_ACCESS_SECRET
const REFRESH_SECRET = env.JWT_REFRESH_SECRET ?? env.JWT_ACCESS_SECRET

export function signAccess(payload: Omit<JwtAccessPayload, 'iat' | 'exp'>, expiresIn?: string): string {
  return jwt.sign(
    payload,
    ACCESS_SECRET,
    { expiresIn: expiresIn ?? env.JWT_ACCESS_EXPIRES_IN, algorithm: 'HS256' } as jwt.SignOptions,
  )
}

export function signRefresh(payload: Omit<JwtRefreshPayload, 'iat' | 'exp'>): string {
  return jwt.sign(
    payload,
    REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN, algorithm: 'HS256' } as jwt.SignOptions,
  )
}

export function verifyAccess(token: string): JwtAccessPayload {
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'] }) as JwtAccessPayload
}

export function verifyRefresh(token: string): JwtRefreshPayload {
  return jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'] }) as JwtRefreshPayload
}
