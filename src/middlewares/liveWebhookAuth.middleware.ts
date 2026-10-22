import { timingSafeEqual } from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env'
import { AppError } from './errorHandler'

const matches = (actual: Buffer, secret: string | undefined): boolean => {
  if (!secret) return false
  const expected = Buffer.from(secret)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * Validates X-Live-Webhook-Secret header against env.LIVE_WEBHOOK_SECRET, or
 * LIVE_WEBHOOK_SECRET_PREVIOUS while a rotation is in progress (SEC-01).
 * Use as a preHandler on live webhook routes.
 */
export async function verifyLiveWebhookSecret(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const provided = req.headers['x-live-webhook-secret'] as string | undefined
  const actual = Buffer.from(provided ?? '')

  if (!matches(actual, env.LIVE_WEBHOOK_SECRET) && !matches(actual, env.LIVE_WEBHOOK_SECRET_PREVIOUS)) {
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  }
}
