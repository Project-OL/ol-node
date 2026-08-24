import { FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from './errorHandler'
import { lastActiveTracker } from './lastActiveTracker.middleware'
import type { JwtAccessPayload } from '../models/types'
import {
  loadAuthHotPath,
  resolveUserTokenVersion,
  sessionService,
} from '../services/session.service'
import { deviceBanService } from '../services/device-ban.service'
import { userRepository } from '../repositories/user.repository'
import { ensureUserMayAuthenticate } from '../utils/user-account-status'

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
  const hot = await loadAuthHotPath({
    userId: resolvedUserId,
    sessionId: payload.sessionId,
    deviceId: payload.deviceId,
  }).catch(() => ({ tokenVersion: null, sessionRaw: null, deviceBanned: null }))

  const userTv =
    hot.tokenVersion != null
      ? Number(hot.tokenVersion)
      : await resolveUserTokenVersion(resolvedUserId)
  if (tvInToken !== userTv) {
    // Ban / suspend / password-reset bump tokenVersion to force logout. Prefer
    // account-status errors when applicable; otherwise SESSION_INVALID so clients
    // clear tokens instead of surfacing TOKEN_VERSION_MISMATCH.
    const statusRow = await userRepository.findAuthStatusById(resolvedUserId)
    if (statusRow) {
      await ensureUserMayAuthenticate(statusRow)
    }
    throw new AppError(401, 'Session revoked. Please log in again.', 'SESSION_INVALID')
  }

  if (payload.sessionId != null) {
    const stv = payload.sessionTokenVersion ?? 0
    await sessionService.validateAccessSession(
      payload.sessionId,
      stv,
      resolvedUserId,
      hot.sessionRaw,
    )
  }

  request.user = payload
  request.userId = resolvedUserId
  request.jti = payload.jti
  request.deviceId = payload.deviceId
  request.sessionId = payload.sessionId

  await deviceBanService.assertDeviceNotBanned(payload.deviceId, hot.deviceBanned)

  void lastActiveTracker(request, reply).catch(() => {
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
