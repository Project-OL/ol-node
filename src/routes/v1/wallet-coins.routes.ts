import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { coinTopupRateLimit } from '../../middlewares/rateLimitAuth'
import { coinWalletService } from '../../services/coin-wallet.service'
import { walletService } from '../../services/wallet.service'
import {
  TopupInitiateSchema,
  TopupConfirmSchema,
  CoinHistoryQuerySchema,
} from '../../models/wallet.schemas'

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

  app.post(
    '/topup/confirm',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = TopupConfirmSchema.parse(request.body)
      const result = await coinWalletService.confirmTopup(
        request.userId!,
        body.orderId,
        body.gatewayRef,
        body.idempotencyKey,
      )
      return reply.send(result)
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
