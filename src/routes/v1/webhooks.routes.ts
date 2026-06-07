import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../middlewares/errorHandler'
import { verifyLiveWebhookSecret } from '../../middlewares/liveWebhookAuth.middleware'
import { epayClient } from '../../lib/epay.client'
import { coinWalletService } from '../../services/coin-wallet.service'
import { coinTradingService } from '../../services/coinTrading.service'
import { liveSessionService } from '../../services/liveSession.service'
import { enqueueWebhookRetry } from '../../queues/epay-webhook.queue'
import { prisma } from '../../config/database'

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

export async function webhooksRoutes(app: FastifyInstance) {
  app.post('/epay', async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = String(request.headers['x-epay-signature'] ?? '')
    const raw = Buffer.from(JSON.stringify(request.body ?? {}))
    if (!epayClient.verifyWebhookSignature(raw, signature)) {
      throw new AppError(401, 'Invalid signature', 'INVALID_WEBHOOK_SIGNATURE')
    }
    const payload = request.body as {
      orderType: 'PERSONAL_TOPUP' | 'TRADING_TOPUP'
      orderId: string
      gatewayRef: string
      amountUsd: number
      userId?: string
    }
    try {
      if (payload.orderType === 'PERSONAL_TOPUP') {
        const order = await prisma.coinTopupOrder.findUnique({ where: { id: payload.orderId } })
        if (order?.userId) {
          await coinWalletService.confirmTopup(
            order.userId,
            payload.orderId,
            payload.gatewayRef,
            `epay-personal-topup:${payload.orderId}`,
          )
        }
      } else {
        const order = await prisma.coinTradingTopupOrder.findUnique({
          where: { id: payload.orderId },
        })
        if (order) {
          await coinTradingService.confirmTopup(order, payload)
        }
      }
    } catch (_err) {
      await enqueueWebhookRetry(payload, payload.orderType)
    }
    return reply.send({ ok: true })
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
          parsed.error.errors[0]?.message ?? 'Invalid body',
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
          parsed.error.errors[0]?.message ?? 'Invalid body',
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
}
