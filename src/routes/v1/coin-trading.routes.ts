import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
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

const topupSchema = z
  .object({
    packageId: z.string().uuid().optional(),
    amountUsd: z.number().positive().optional(),
    currency: z.string().default('USD'),
    callbackUrl: z.string().url().optional(),
    returnUrl: z.string().url().optional(),
  })
  .refine((b) => b.packageId != null || b.amountUsd != null, {
    message: 'packageId or amountUsd required',
  })
const exchangeSchema = z.object({
  pointsToExchange: z.string().min(1),
  securityPassword: z.string().optional(),
})
const transferSchema = z.object({
  recipientPublicId: z.string().min(1),
  tradingCoins: z.string().min(1),
  targetWalletType: z.enum(['PERSONAL', 'TRADING']).optional(),
  idempotencyKey: z.string().min(1),
})

const ListTransfersQuerySchema = z.object({
  role: z.enum(['sender', 'recipient', 'all']).default('all'),
  direction: z.enum(['credit', 'debit']).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
})

export default async function coinTradingRoutes(app: FastifyInstance) {
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

  app.get('/rates', { preHandler: [authenticate] }, async (_request, reply) => {
    const [topupRates, exchangeRates] = await Promise.all([
      coinTradingService.getTopupRates(),
      coinTradingService.getExchangeRates(),
    ])
    return reply.send({ topupRates, exchangeRates })
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
      const user = await userRepository.findById(request.userId!)
      if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
      const body = exchangeSchema.parse(request.body ?? {})
      const securityPassword = String(
        request.headers['x-security-password'] ?? body.securityPassword ?? '',
      )
      await securityPasswordService.verifyCurrentPassword(request.userId!, securityPassword)
      const result = await coinTradingService.exchangePointsForTradingCoins(
        request.userId!,
        BigInt(body.pointsToExchange),
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
    '/transfers',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = ListTransfersQuerySchema.parse(request.query ?? {})
      const result = await coinTradingService.listTransferHistory(request.userId!, {
        role: parsed.role,
        direction: parsed.direction,
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
