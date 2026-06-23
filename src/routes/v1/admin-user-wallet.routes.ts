import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { adminWalletService } from '../../services/adminWallet.service'
import { adminUserTransactionsService } from '../../services/adminUserTransactions.service'
import {
  adminTransactionListQuerySchema,
  adminWalletAmountBodySchema,
} from '../../models/admin-user-wallet.schemas'

const preAuth = [authenticateAdmin]

function parseAmountBody(body: unknown) {
  const parsed = adminWalletAmountBodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
  }
  return {
    amount: BigInt(parsed.data.amount),
    description: parsed.data.description,
    idempotencyKey: parsed.data.idempotencyKey,
  }
}

function parseTxQuery(query: unknown) {
  const parsed = adminTransactionListQuerySchema.safeParse(query ?? {})
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
  }
  return parsed.data
}

export default async function adminUserWalletRoutes(app: FastifyInstance) {
  app.get(
    '/users/transactions/filter-types',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description:
          'Filter type values for admin user transaction history (personal coins, points, trading coins).',
      },
    },
    async (_request, reply) => {
      return reply.send(adminUserTransactionsService.getFilterTypes())
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/transactions/coins',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description: 'Personal coin transaction history for a user.',
      },
    },
    async (request, reply) => {
      const filter = parseTxQuery(request.query)
      return reply.send(
        await adminUserTransactionsService.listPersonalCoinTransactions(
          request.params.userId,
          filter,
        ),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/transactions/points',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description: 'Point transaction history for a user.',
      },
    },
    async (request, reply) => {
      const filter = parseTxQuery(request.query)
      return reply.send(
        await adminUserTransactionsService.listPointTransactions(request.params.userId, filter),
      )
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/users/:userId/transactions/trading-coins',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description: 'Trading coin transaction history for a user.',
      },
    },
    async (request, reply) => {
      const filter = parseTxQuery(request.query)
      return reply.send(
        await adminUserTransactionsService.listTradingCoinTransactions(
          request.params.userId,
          filter,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/personal-coins/add',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users', 'Wallet'],
        description: 'Credit personal coins to a user.',
      },
    },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const body = parseAmountBody(request.body)
      const adminId = request.adminUser!.id
      const result = await adminWalletService.creditUserWallets({
        adminUserId: adminId,
        targetUserId: request.params.userId,
        coins: body.amount,
        description: body.description,
        idempotencyKey: body.idempotencyKey,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/personal-coins/deduct',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      const body = parseAmountBody(request.body)
      return reply.send(
        await adminWalletService.debitPersonalCoins({
          adminUserId: request.adminUser!.id,
          targetUserId: request.params.userId,
          amount: body.amount,
          description: body.description,
          idempotencyKey: body.idempotencyKey,
        }),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/trading-coins/add',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      const body = parseAmountBody(request.body)
      const result = await adminWalletService.creditUserWallets({
        adminUserId: request.adminUser!.id,
        targetUserId: request.params.userId,
        tradingCoins: body.amount,
        description: body.description,
        idempotencyKey: body.idempotencyKey,
        forceTradingCredit: true,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/trading-coins/deduct',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      const body = parseAmountBody(request.body)
      return reply.send(
        await adminWalletService.debitTradingCoins({
          adminUserId: request.adminUser!.id,
          targetUserId: request.params.userId,
          amount: body.amount,
          description: body.description,
          idempotencyKey: body.idempotencyKey,
        }),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/points/add',
    {
      preHandler: preAuth,
      schema: { tags: ['Admin', 'Users', 'Wallet'], description: 'Credit points to a user.' },
    },
    async (request, reply) => {
      const body = parseAmountBody(request.body)
      const result = await adminWalletService.creditUserWallets({
        adminUserId: request.adminUser!.id,
        targetUserId: request.params.userId,
        points: body.amount,
        description: body.description,
        idempotencyKey: body.idempotencyKey,
      })
      return reply.send(result)
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/points/deduct',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      const body = parseAmountBody(request.body)
      return reply.send(
        await adminWalletService.debitPoints({
          adminUserId: request.adminUser!.id,
          targetUserId: request.params.userId,
          amount: body.amount,
          description: body.description,
          idempotencyKey: body.idempotencyKey,
        }),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/personal-coins/freeze',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      return reply.send(
        await adminWalletService.setPersonalCoinsFrozen(
          request.params.userId,
          true,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/personal-coins/unfreeze',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      return reply.send(
        await adminWalletService.setPersonalCoinsFrozen(
          request.params.userId,
          false,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/trading-coins/freeze',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      return reply.send(
        await adminWalletService.setTradingCoinsFrozen(
          request.params.userId,
          true,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/trading-coins/unfreeze',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      return reply.send(
        await adminWalletService.setTradingCoinsFrozen(
          request.params.userId,
          false,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/points/freeze',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      return reply.send(
        await adminWalletService.setPointsFrozen(
          request.params.userId,
          true,
          request.adminUser!.id,
        ),
      )
    },
  )

  app.post<{ Params: { userId: string } }>(
    '/users/:userId/wallet/points/unfreeze',
    { preHandler: preAuth, schema: { tags: ['Admin', 'Users', 'Wallet'] } },
    async (request, reply) => {
      return reply.send(
        await adminWalletService.setPointsFrozen(
          request.params.userId,
          false,
          request.adminUser!.id,
        ),
      )
    },
  )
}
