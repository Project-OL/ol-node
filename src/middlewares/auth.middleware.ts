import { FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from './errorHandler'
import { lastActiveTracker } from './lastActiveTracker.middleware'
import type { JwtAccessPayload } from '../models/types'
import { resolveUserTokenVersion, sessionService } from '../services/session.service'
import { deviceBanService } from '../services/device-ban.service'

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string
    jti?: string
    deviceId?: string
    sessionId?: string
  }
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) return undefined
  const token = auth.slice(7).trim()
  return token.length > 0 ? token : undefined
}

async function applyVerifiedAccessPayload(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: JwtAccessPayload,
): Promise<void> {
  const resolvedUserId = payload.userId ?? payload.sub
  if (!resolvedUserId) {
    throw new AppError(401, 'Invalid token', 'INVALID_TOKEN')
  }

  const tvInToken = payload.tokenVersion ?? 0
  const userTv = await resolveUserTokenVersion(resolvedUserId)
  if (tvInToken !== userTv) {
    throw new AppError(401, 'Token version mismatch', 'TOKEN_VERSION_MISMATCH')
  }

  if (payload.sessionId != null) {
    const stv = payload.sessionTokenVersion ?? 0
    await sessionService.validateAccessSession(payload.sessionId, stv, resolvedUserId)
  }

  request.user = payload
  request.userId = resolvedUserId
  request.jti = payload.jti
  request.deviceId = payload.deviceId
  request.sessionId = payload.sessionId

  await deviceBanService.assertDeviceNotBanned(payload.deviceId)

  await lastActiveTracker(request, reply).catch(() => {
    /* non-fatal */
  })
}

/**
 * JWT verify + user.tokenVersion gate + optional session row validation (Redis-first).
 * OpenTelemetry-style trace id: use request.id (Fastify genReqId) in route logs.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(request)
  if (!token) {
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  }

  let payload: JwtAccessPayload
  try {
    payload = request.server.jwt.verify<JwtAccessPayload>(token)
    await applyVerifiedAccessPayload(request, reply, payload)
  } catch (e) {
    if (e instanceof AppError) throw e
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  }
}

/**
 * Best-effort JWT verify: sets user/device context when the token is valid; otherwise continues
 * without auth (e.g. device factory reset with no stored access token).
 *
 * Uses `jwt.verify` (not `jwtVerify`) so a bad/expired token never poisons the reply with 401.
 */
export async function authenticateOptional(request: FastifyRequest, reply: FastifyReply) {
  const token = extractBearerToken(request)
  if (!token) return

  try {
    const payload = request.server.jwt.verify<JwtAccessPayload>(token)
    await applyVerifiedAccessPayload(request, reply, payload)
  } catch {
    /* invalid, expired, or revoked — continue unauthenticated */
  }
}
