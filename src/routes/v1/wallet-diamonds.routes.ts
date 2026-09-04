import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { diamondWalletService } from '../../services/diamond-wallet.service'
import { diamondConversionService } from '../../services/diamond-conversion.service'
import {
  DiamondHistoryQuerySchema,
  DiamondBuySchema,
  DiamondRedeemSchema,
} from '../../models/wallet.schemas'

export async function walletDiamondsRoutes(app: FastifyInstance) {
  app.get(
    '/balance',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const balance = await diamondWalletService.getBalance(request.userId!)
      return reply.send({ balance: balance.toString() })
    },
  )

  app.get(
    '/history',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = DiamondHistoryQuerySchema.parse(request.query)
      const result = await diamondWalletService.getHistory(request.userId!, {
        types: query.types,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit: query.limit,
      })
      return reply.send(result)
    },
  )

  app.post(
    '/buy',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = DiamondBuySchema.parse(request.body)
      const result = await diamondConversionService.buyDiamonds(
        request.userId!,
        body.coinAmount,
        body.idempotencyKey,
      )
      return reply.status(201).send({
        id: result.id,
        coinAmount: result.coinAmount.toString(),
        diamondAmount: result.diamondAmount.toString(),
        createdAt: result.createdAt,
      })
    },
  )

  app.post(
    '/redeem',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = DiamondRedeemSchema.parse(request.body)
      const result = await diamondConversionService.redeemDiamonds(
        request.userId!,
        body.diamondAmount,
        body.idempotencyKey,
      )
      return reply.status(201).send({
        id: result.id,
        coinAmount: result.coinAmount.toString(),
        diamondAmount: result.diamondAmount.toString(),
        createdAt: result.createdAt,
      })
    },
  )
}
