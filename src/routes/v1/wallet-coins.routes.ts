import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { coinTopupRateLimit } from '../../middlewares/rateLimitAuth'
import { coinWalletService } from '../../services/coin-wallet.service'
import { walletService } from '../../services/wallet.service'
import { AppError } from '../../middlewares/errorHandler'
import {
  TopupInitiateSchema,
  CoinHistoryQuerySchema,
  TopupOrderParamsSchema,
} from '../../models/wallet.schemas'
import { epayPayinService } from '../../services/epay-payin.service'

export async function walletCoinsRoutes(app: FastifyInstance) {
  app.get(
    '/balance',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const balance = await walletService.getCoinBalance(request.userId!)
      return reply.send({ balance: balance.toString() })
    },
  )

  app.get(
    '/packages',
    { preHandler: [authenticate] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const packages = await coinWalletService.listPackages()
      return reply.send({ packages })
    },
  )

  app.post(
    '/topup/initiate',
    { preHandler: [authenticate, coinTopupRateLimit] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = TopupInitiateSchema.parse(request.body)
      const result = await coinWalletService.initiateTopup(
        request.userId!,
        body.packageId,
        body.idempotencyKey,
      )
      return reply.status(201).send(result)
    },
  )

  /**
   * Retired (Epay P0, 2026-11-20). This used to credit coins for any client-supplied
   * `gatewayRef` with no gateway check, so anyone could mint coins against a PENDING order.
   * Top-ups are now settled only server-side, from a signed Epay callback re-verified by a
   * status query. The path stays registered (API contract) but never credits.
   */
  app.post('/topup/confirm', { preHandler: [authenticate] }, async () => {
    throw new AppError(
      410,
      'Top-ups are confirmed automatically once the payment completes',
      'TOPUP_CONFIRM_REMOVED',
    )
  })

  /**
   * Buyer's order status; polled after the Epay page closes. One indexed read, answers
   * immediately; a PENDING order also kicks a single-flight background Epay check.
   */
  app.get<{ Params: { orderId: string } }>(
    '/topup/orders/:orderId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { orderId } = TopupOrderParamsSchema.parse(request.params)
      const { view, pendingMerchantOrderNo } = await coinWalletService.getTopupOrder(
        request.userId!,
        orderId,
      )
      epayPayinService.kickRefresh(pendingMerchantOrderNo)
      return reply.send(view)
    },
  )

  app.get(
    '/history',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = CoinHistoryQuerySchema.parse(request.query)
      const result = await coinWalletService.getHistory(request.userId!, {
        types: query.types,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit: query.limit,
      })
      return reply.send(result)
    },
  )
}
