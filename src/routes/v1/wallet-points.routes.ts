import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { rateLimitWithdrawalCreate } from '../../middlewares/rateLimitAuth'
import { pointWalletService } from '../../services/point-wallet.service'
import {
  WithdrawInitiateSchema,
  PointHistoryQuerySchema,
  PointLedgerEntryParamsSchema,
  PointLedgerRefParamsSchema,
} from '../../models/wallet.schemas'

export async function walletPointsRoutes(app: FastifyInstance) {
  app.get(
    '/summary',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await pointWalletService.getSummary(request.userId!)
      return reply.send(result)
    },
  )

  app.get(
    '/balance',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { total, available, unconfirmed } = await pointWalletService.getBalanceBreakdown(
        request.userId!,
      )
      return reply.send({
        // `balance` retained for backward compatibility (== totalPoints).
        balance: total.toString(),
        totalPoints: total.toString(),
        availablePoints: available.toString(),
        unconfirmedPoints: unconfirmed.toString(),
      })
    },
  )

  app.get(
    '/balance/usd',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const result = await pointWalletService.getBalanceWithUsd(request.userId!)
      return reply.send(result)
    },
  )

  app.post(
    '/withdraw',
    { preHandler: [authenticate, rateLimitWithdrawalCreate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = WithdrawInitiateSchema.parse(request.body)
      const result = await pointWalletService.initiateWithdrawal(
        request.userId!,
        body.grossPoints,
        body.paymentMethodId,
        body.idempotencyKey,
        body.notes,
      )
      return reply.status(201).send(result)
    },
  )

  app.get(
    '/history',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = PointHistoryQuerySchema.parse(request.query)
      const result = await pointWalletService.getHistory(request.userId!, {
        types: query.types as string[] | undefined,
        from: query.from,
        to: query.to,
        cursor: query.cursor,
        limit: query.limit,
      })
      return reply.send(result)
    },
  )

  app.get(
    '/history/by-ref/:refId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { refId } = PointLedgerRefParamsSchema.parse(request.params)
      const result = await pointWalletService.getTransactionsByRefId(request.userId!, refId)
      return reply.send(result)
    },
  )

  app.get(
    '/history/:entryId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { entryId } = PointLedgerEntryParamsSchema.parse(request.params)
      const result = await pointWalletService.getTransactionDetail(request.userId!, entryId)
      return reply.send(result)
    },
  )
}
