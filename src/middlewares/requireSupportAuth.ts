import type { FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from './errorHandler'
import type { JwtAccessPayload } from '../models/types'

/**
 * Gate middleware for Customer Support (CS) actors.
 *
 * Must run AFTER `authenticate` (which attaches request.user via JWT).
 * Grants access only when the resolved JWT user has isSupport = true.
 *
 * Usage:
 *   preHandler: [authenticate, requireSupportAuth]
 */
export async function requireSupportAuth(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const payload = request.user as JwtAccessPayload | undefined
  if (!payload?.isSupport) {
    throw new AppError(403, 'Forbidden: Customer Support access required', 'CS_ACCESS_REQUIRED')
  }
}
