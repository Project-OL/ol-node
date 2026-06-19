import { FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from './errorHandler'
import { lastActiveTracker } from './lastActiveTracker.middleware'
import type { JwtAccessPayload } from '../models/types'
import { resolveUserTokenVersion, sessionService } from '../services/session.service'

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string
    jti?: string
    deviceId?: string
    sessionId?: string
  }
}

/**
 * JWT verify + user.tokenVersion gate + optional session row validation (Redis-first).
 * OpenTelemetry-style trace id: use request.id (Fastify genReqId) in route logs.
 */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  }

  const payload = request.user as JwtAccessPayload
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

  request.userId = resolvedUserId
  request.jti = payload.jti
  request.deviceId = payload.deviceId
  request.sessionId = payload.sessionId

  await lastActiveTracker(request, _reply).catch(() => {
    /* non-fatal */
  })
}

/**
 * Best-effort JWT verify: sets user/device context when the token is valid; otherwise continues
 * without auth (e.g. device factory reset with no stored access token).
 */
export async function authenticateOptional(request: FastifyRequest, _reply: FastifyReply) {
  try {
    await request.jwtVerify()
  } catch {
    return
  }

  const payload = request.user as JwtAccessPayload
  const resolvedUserId = payload.userId ?? payload.sub
  if (!resolvedUserId) {
    return
  }

  try {
    const tvInToken = payload.tokenVersion ?? 0
    const userTv = await resolveUserTokenVersion(resolvedUserId)
    if (tvInToken !== userTv) {
      return
    }

    if (payload.sessionId != null) {
      const stv = payload.sessionTokenVersion ?? 0
      await sessionService.validateAccessSession(payload.sessionId, stv, resolvedUserId)
    }

    request.userId = resolvedUserId
    request.jti = payload.jti
    request.deviceId = payload.deviceId
    request.sessionId = payload.sessionId

    await lastActiveTracker(request, _reply).catch(() => {
      /* non-fatal */
    })
  } catch {
    /* invalid or revoked session — treat as unauthenticated for optional routes */
  }
}
