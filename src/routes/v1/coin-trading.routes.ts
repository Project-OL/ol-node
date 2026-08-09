import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { CoinTxType } from '@prisma/client'
import { z } from 'zod'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { coinTradingService } from '../../services/coinTrading.service'
import { securityPasswordService } from '../../services/security-password.service'
import {
  rateLimitCtExchange,
  rateLimitCtTopup,
  rateLimitCtTransfer,
} from '../../middlewares/rateLimitAuth'
import { userRepository } from '../../repositories/user.repository'
import { env } from '../../config/env'

const topupSchema = z
  .object({
    packageId: z.string().uuid().optional(),
    amountUsd: z.number().positive().optional(),
    currency: z.string().default('USD'),
    callbackUrl: z.string().url().optional(),
    returnUrl: z.string().url().optional(),
    /** Optional client retry token; same key replays the original order instead of creating another. */
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .refine((b) => b.packageId != null || b.amountUsd != null, {
    message: 'packageId or amountUsd required',
  })
const exchangeSchema = z.object({
  pointsToExchange: z.string().min(1),
  securityPassword: z.string().optional(),
  /** Optional client retry token; same key replays the original result instead of re-exchanging. */
  idempotencyKey: z.string().min(8).max(128).optional(),
})
const transferSchema = z.object({
  recipientPublicId: z.string().min(1),
  tradingCoins: z.string().min(1),
  targetWalletType: z.enum(['PERSONAL', 'TRADING']).optional(),
  idempotencyKey: z.string().min(1),
})

const listTransfersRoleSchema =
  env.NODE_ENV === 'production'
    ? z.enum(['sent', 'received', 'all']).optional()
    : z.enum(['sent', 'received', 'all']).optional()

const ListTransfersQuerySchema = z.object({
  direction: z.enum(['credit', 'debit']).optional(),
  role: listTransfersRoleSchema,
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
})

function resolveTransferDirection(parsed: z.infer<typeof ListTransfersQuerySchema>) {
  if (parsed.direction) return parsed.direction
  if (parsed.role === 'sent') return 'debit' as const
  if (parsed.role === 'received') return 'credit' as const
  return undefined
}

const ListHistoryQuerySchema = z.object({
  direction: z.enum(['credit', 'debit']).optional(),
  types: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
})

export default async function coinTradingRoutes(app: FastifyInstance) {
  app.get('/exchange/packages', { preHandler: [authenticate] }, async (request, reply) => {
    const packages = await coinTradingService.getExchangePackages(request.userId!)
    return reply.send({ packages })
  })

  app.get(
    '/balance',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const balance = await coinTradingService.getTradingBalance(request.userId!)
      return reply.send({ balance: balance.toString() })
    },
  )

  app.get('/rates', { preHandler: [authenticate] }, async (request, reply) => {
    const rates = await coinTradingService.getRatesForCaller(request.userId!)
    return reply.send(rates)
  })

  app.get(
    '/topup/packages',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const packages = await coinTradingService.getTopupPackages()
      return reply.send({ packages })
    },
  )

  app.post(
    '/topup/initiate',
    { preHandler: [authenticate, rateLimitCtTopup] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const body = topupSchema.parse(request.body ?? {})
      const result = await coinTradingService.initiateTopup(request.userId!, {
        packageId: body.packageId,
        amountUsd: body.amountUsd,
        currency: body.currency,
        idempotencyKey: body.idempotencyKey,
        callbackUrl:
          body.callbackUrl ?? `${request.protocol}://${request.hostname}/api/v1/webhooks/epay`,
        returnUrl: body.returnUrl ?? `${request.protocol}://${request.hostname}`,
      })
      return reply.status(201).send(result)
    },
  )

  app.get(
    '/topup/orders',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const q = request.query as { limit?: string; cursor?: string }
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
      const rows = await coinTradingService.listTopupHistory(request.userId!, {
        limit,
        cursor: q.cursor,
      })
      return reply.send({ items: rows })
    },
  )

  app.post(
    '/exchange',
    { preHandler: [authenticate, rateLimitCtExchange] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = exchangeSchema.parse(request.body ?? {})
      const securityPassword = String(
        request.headers['x-security-password'] ?? body.securityPassword ?? '',
      )
      await securityPasswordService.verifyCurrentPassword(request.userId!, securityPassword)
      const result = await coinTradingService.exchangePointsForTradingCoins(
        request.userId!,
        BigInt(body.pointsToExchange),
        body.idempotencyKey,
      )
      return reply.send(result)
    },
  )

  app.post(
    '/transfer',
    { preHandler: [authenticate, rateLimitCtTransfer] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const body = transferSchema.parse(request.body ?? {})
      const result = await coinTradingService.transferTradingCoins(request.userId!, {
        recipientPublicId: body.recipientPublicId,
        tradingCoins: BigInt(body.tradingCoins),
        targetWalletType: body.targetWalletType,
        idempotencyKey: body.idempotencyKey,
      })
      return reply.status(201).send(result)
    },
  )

  app.get(
    '/transactions',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListHistoryQuerySchema.parse(request.query ?? {})
      const types = parsed.types
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean) as CoinTxType[] | undefined
      const result = await coinTradingService.listAllTradingTransactions(request.userId!, {
        direction: parsed.direction,
        types,
        fromDate: parsed.fromDate ? new Date(parsed.fromDate) : undefined,
        toDate: parsed.toDate ? new Date(parsed.toDate) : undefined,
        limit: parsed.limit,
        cursor: parsed.cursor,
      })
      return reply.send(result)
    },
  )

  app.get(
    '/history',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListHistoryQuerySchema.parse(request.query ?? {})
      const types = parsed.types
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean) as CoinTxType[] | undefined
      const result = await coinTradingService.listTradingCoinHistory(request.userId!, {
        direction: parsed.direction,
        types,
        fromDate: parsed.fromDate ? new Date(parsed.fromDate) : undefined,
        toDate: parsed.toDate ? new Date(parsed.toDate) : undefined,
        limit: parsed.limit,
        cursor: parsed.cursor,
      })
      return reply.send(result)
    },
  )

  app.get(
    '/transfers',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListTransfersQuerySchema.parse(request.query ?? {})
      const result = await coinTradingService.listTransferHistory(request.userId!, {
        direction: resolveTransferDirection(parsed),
        fromDate: parsed.fromDate ? new Date(parsed.fromDate) : undefined,
        toDate: parsed.toDate ? new Date(parsed.toDate) : undefined,
        limit: parsed.limit,
        cursor: parsed.cursor,
      })
      return reply.send(result)
    },
  )

  app.get(
    '/recent-users',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const rows = await coinTradingService.getRecentTransactionUsers(request.userId!)
      return reply.send({ users: rows })
    },
  )
}
