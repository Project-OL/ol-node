import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../middlewares/errorHandler'
import { verifyLiveWebhookSecret } from '../../middlewares/liveWebhookAuth.middleware'
import {
  isEpayConfigured,
  parseEpayCallbackBody,
  verifyEpayCallback,
} from '../../lib/epay/epay-gateway.client'
import { epayOrderKindOf } from '../../lib/epay/epay-order-no'
import { env } from '../../config/env'
import { clientIp } from '../../utils/client-ip'
import { epayPayinService } from '../../services/epay-payin.service'
import { liveSessionService } from '../../services/liveSession.service'

const LiveSessionStartSchema = z.object({
  hostUserId: z.string().min(1),
  agencyUserId: z.string().min(1),
  roomId: z.string().min(1),
  startedAt: z.string().datetime().optional(),
})

const LiveSessionEndSchema = z.object({
  hostUserId: z.string().min(1),
  roomId: z.string().min(1),
  durationSeconds: z.number().min(0),
  endedAt: z.string().datetime().optional(),
})

const ModerationNotifySchema = z.object({
  type: z.enum(['LIVE_CHAT_MUTE', 'LIVE_AUDIO_MUTE']),
  targetUserId: z.string().min(1),
  reason: z.string().max(500).optional(),
  restrictedUntil: z.string().datetime(),
  performedByAdminId: z.string().min(1),
})

/** Flatten a parsed callback body (form or JSON) into the string fields Epay signed. */
function callbackFields(body: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!body || typeof body !== 'object') return out
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v == null) continue
    out[k] = typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  return out
}

export async function webhooksRoutes(app: FastifyInstance) {
  // Epay notifies with application/x-www-form-urlencoded. Registered inside this plugin only
  // (Fastify encapsulation), so no other route starts accepting form bodies.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_request, body, done) => {
      try {
        done(null, parseEpayCallbackBody(body as string))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  /**
   * Epay async notification (pay-in and payout). Flow: verify `sign` with the key for the
   * order's direction → settle from Epay's OWN status query (the callback body is never
   * trusted for amounts) → reply plain `success` so Epay stops retrying. Any non-`success`
   * answer makes Epay retry (16 times over ~4 h), which is what we want on transient errors;
   * the epay-reconcile job is the backstop either way.
   */
  app.post('/epay', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isEpayConfigured()) {
      throw new AppError(503, 'Epay is not enabled', 'EPAY_DISABLED')
    }
    // Source-IP allowlist (defence in depth; the signature check below is the real gate).
    const allowed = env.EPAY_CALLBACK_IPS
    if (env.EPAY_CALLBACK_IP_MODE !== 'off' && allowed.length > 0) {
      const ip = clientIp(request)
      if (!ip || !allowed.includes(ip)) {
        request.log.warn({ ip, mode: env.EPAY_CALLBACK_IP_MODE }, 'epay callback: unlisted IP')
        if (env.EPAY_CALLBACK_IP_MODE === 'enforce') {
          throw new AppError(403, 'Forbidden', 'EPAY_CALLBACK_IP_FORBIDDEN')
        }
      }
    }
    const fields = callbackFields(request.body)
    const merchantOrderNo = fields.merchantOrderNo
    const kind = epayOrderKindOf(merchantOrderNo)
    if (!kind) {
      request.log.warn({ merchantOrderNo }, 'epay callback: unknown merchantOrderNo')
      throw new AppError(400, 'Unknown order', 'EPAY_UNKNOWN_ORDER')
    }
    const keyKind = kind === 'WITHDRAWAL_PAYOUT' ? 'PAYOUT' : 'PAYIN'
    if (!verifyEpayCallback(fields, keyKind)) {
      request.log.warn({ merchantOrderNo, kind }, 'epay callback: invalid signature')
      throw new AppError(401, 'Invalid signature', 'INVALID_WEBHOOK_SIGNATURE')
    }

    if (kind === 'WITHDRAWAL_PAYOUT') {
      const { epayPayoutService } = await import('../../services/epay-payout.service')
      const result = await epayPayoutService.settlePayout(merchantOrderNo, 'callback')
      request.log.info({ merchantOrderNo, result }, 'epay payout callback handled')
    } else {
      const result = await epayPayinService.settlePayin(merchantOrderNo, 'callback')
      request.log.info({ merchantOrderNo, result }, 'epay pay-in callback handled')
    }
    return reply.type('text/plain').send('success')
  })

  // Live session events (from LiveKit backend server)
  // Auth: X-Live-Webhook-Secret header
  app.post(
    '/live/session-start',
    { preHandler: [verifyLiveWebhookSecret] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LiveSessionStartSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.issues[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const body = parsed.data
      const result = await liveSessionService.handleSessionStart({
        hostUserId: body.hostUserId,
        agencyUserId: body.agencyUserId,
        roomId: body.roomId,
        startedAt: body.startedAt ? new Date(body.startedAt) : undefined,
      })
      return reply.code(200).send({ ok: true, alreadyActive: result.alreadyActive })
    },
  )

  app.post(
    '/live/session-end',
    { preHandler: [verifyLiveWebhookSecret] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = LiveSessionEndSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.issues[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const body = parsed.data
      const result = await liveSessionService.handleSessionEnd({
        hostUserId: body.hostUserId,
        roomId: body.roomId,
        durationSeconds: body.durationSeconds,
        endedAt: body.endedAt ? new Date(body.endedAt) : undefined,
      })
      return reply.code(200).send({ ok: true, alreadyEnded: result.alreadyEnded })
    },
  )

  /**
   * Livestream backend: fetch active timed restrictions (chat mute / audio mute / start ban).
   * Auth: X-Live-Webhook-Secret
   */
  app.get<{ Params: { userId: string } }>(
    '/live/user-restrictions/:userId',
    { preHandler: [verifyLiveWebhookSecret] },
    async (request, reply) => {
      const { userRestrictionService } = await import('../../services/userRestriction.service')
      return reply.send(await userRestrictionService.listActiveForUser(request.params.userId))
    },
  )

  /**
   * Live-server: notify all SUPER_ADMINs after it applies LIVE_CHAT_MUTE /
   * LIVE_AUDIO_MUTE (those two types are created on Live-server, not here).
   * Auth: X-Live-Webhook-Secret
   */
  app.post(
    '/live/moderation-notify',
    { preHandler: [verifyLiveWebhookSecret] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ModerationNotifySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.issues[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const body = parsed.data
      const { superAdminNotificationService } =
        await import('../../services/superAdminNotification.service')
      await superAdminNotificationService.notifyAll(body.type, {
        targetUserId: body.targetUserId,
        reason: body.reason,
        restrictedUntil: new Date(body.restrictedUntil),
        performedByAdminId: body.performedByAdminId,
      })
      return reply.code(200).send({ ok: true })
    },
  )
}
