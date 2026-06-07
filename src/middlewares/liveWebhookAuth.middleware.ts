import { timingSafeEqual } from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env'
import { AppError } from './errorHandler'

/**
 * Validates X-Live-Webhook-Secret header against env.LIVE_WEBHOOK_SECRET.
 * Use as a preHandler on live webhook routes.
 */
export async function verifyLiveWebhookSecret(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const provided = req.headers['x-live-webhook-secret'] as string | undefined
  const expected = Buffer.from(env.LIVE_WEBHOOK_SECRET)
  const actual = Buffer.from(provided ?? '')

  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
  }
}
