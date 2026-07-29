import type { FastifyReply, FastifyRequest } from 'fastify'
import { prisma } from '../config/database'
import { RedisKeys, USER_LAST_ACTIVE_THROTTLE_TTL, redisClient } from '../config/redis'

type TouchLastActiveOptions = {
  /** Override throttle window (seconds). */
  throttleSec?: number
  /**
   * Use the presence-specific Redis gate so WS heartbeats are not blocked by the
   * longer HTTP last-active throttle (`user:lastActive:{id}`).
   */
  presenceGate?: boolean
}

/** Throttled DB write for `users.last_active_at` (shared by HTTP middleware and presence heartbeat). */
export async function touchUserLastActive(
  userId: string,
  options?: TouchLastActiveOptions,
): Promise<void> {
  const gateKey = options?.presenceGate
    ? RedisKeys.userLastActivePresence(userId)
    : RedisKeys.userLastActive(userId)
  const throttleSec = options?.throttleSec ?? USER_LAST_ACTIVE_THROTTLE_TTL
  try {
    const ok = await redisClient.set(gateKey, '1', 'EX', throttleSec, 'NX')
    if (ok !== 'OK') return

    await prisma.user.update({
      where: { id: userId },
      data: { lastActiveAt: new Date() },
    })
  } catch {
    /* ignore activity tracking failures */
  }
}

/**
 * Cheap activity timestamp for agency removal rules. Runs after JWT auth (`authenticate`).
 * Writes DB at most once per USER_LAST_ACTIVE_THROTTLE_TTL seconds per user (Redis gate).
 */
export async function lastActiveTracker(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const userId = request.userId
  if (!userId) return
  await touchUserLastActive(userId)
}
