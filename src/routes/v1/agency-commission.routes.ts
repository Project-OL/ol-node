import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { rateLimitAgencyPointTransfer } from '../../middlewares/rateLimitAuth'
import { agencyCommissionService } from '../../services/agencyCommission.service'
import { agencyRepository } from '../../repositories/agency.repository'
import { securityPasswordService } from '../../services/security-password.service'

const preAuth = [authenticate]

const TransferSchema = z.object({
  recipientAgentPublicId: z.string().min(1),
  points: z.string().min(1),
  /** Prefer header `X-Security-Password`; body field discouraged vs header. */
  securityPassword: z.string().optional(),
  /** Optional client retry token; same key replays the original transfer instead of re-sending. */
  idempotencyKey: z.string().min(8).max(128).optional(),
})

const DateRangeQuerySchema = z
  .object({
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .refine((v) => (v.from == null) === (v.to == null), {
    message: 'from and to must be provided together',
  })

function parseCommissionPeriodQuery(q: Record<string, string | undefined>) {
  const range = DateRangeQuerySchema.safeParse({
    from: q.from,
    to: q.to,
  })
  if (!range.success) {
    throw new AppError(400, range.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
  }
  if (range.data.from && range.data.to) {
    return { from: range.data.from, to: range.data.to }
  }
  const periodDays = Math.min(365, Math.max(1, Number(q.periodDays ?? q.period ?? '30') || 30))
  return { periodDays }
}

export async function registerAgencyCommissionRoutes(app: FastifyInstance) {
  app.get('/commission/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    const rows = await agencyCommissionService.getLevelConfig()
    return reply.send({ levels: rows })
  })

  app.get(
    '/commission/me',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const owned = await agencyRepository.getAgencyByUserId(userId)
      if (!owned) {
        throw new AppError(403, 'Agent only', 'NOT_AN_AGENT')
      }
      const q = request.query as Record<string, string | undefined>
      const periodParams = parseCommissionPeriodQuery(q)
      const snap = await agencyCommissionService.getCommissionMeSnapshot(userId, periodParams)
      return reply.send(snap)
    },
  )

  app.get(
    '/commission/hosts',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const owned = await agencyRepository.getAgencyByUserId(userId)
      if (!owned) {
        throw new AppError(403, 'Agent only', 'NOT_AN_AGENT')
      }
      const q = request.query as Record<string, string | undefined>
      const periodParams = parseCommissionPeriodQuery(q)
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
      const offset = Math.max(0, Number(q.cursor ?? '0') || 0)
      const result = await agencyCommissionService.listHostsByEarnings(userId, periodParams, {
        limit,
        offset,
      })
      return reply.send(result)
    },
  )

  app.get<{ Params: { hostUserId: string } }>(
    '/commission/host/:hostUserId',
    { preHandler: preAuth },
    async (request, reply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const owned = await agencyRepository.getAgencyByUserId(userId)
      if (!owned) {
        throw new AppError(403, 'Agent only', 'NOT_AN_AGENT')
      }
      const q = request.query as Record<string, string | undefined>
      const periodParams = parseCommissionPeriodQuery(q)
      const detail = await agencyCommissionService.getHostCommissionDetail(
        userId,
        request.params.hostUserId,
        periodParams,
      )
      return reply.send(detail)
    },
  )

  app.post(
    '/transfer-points',
    { preHandler: [...preAuth, rateLimitAgencyPointTransfer] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const parsed = TransferSchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      let recipientPid: bigint
      try {
        recipientPid = BigInt(parsed.data.recipientAgentPublicId.trim())
      } catch {
        throw new AppError(400, 'Invalid recipientAgentPublicId', 'INVALID_REQUEST')
      }
      let points: bigint
      try {
        points = BigInt(parsed.data.points)
      } catch {
        throw new AppError(400, 'Invalid points', 'INVALID_REQUEST')
      }

      const securityPassword = String(
        request.headers['x-security-password'] ?? parsed.data.securityPassword ?? '',
      )
      await securityPasswordService.verifyCurrentPassword(userId, securityPassword)

      const recipientAgency = await agencyRepository.getAgencyByPublicId(recipientPid)
      if (!recipientAgency) {
        throw new AppError(400, 'Recipient is not an agent', 'INVALID_RECIPIENT')
      }

      // Client keys are stable across retries (transfer-row replay); without
      // one, each request is a distinct transfer (legacy).
      const idempotencyKey = `agent-point-transfer:${userId}:${
        parsed.data.idempotencyKey ?? Date.now()
      }`

      const result = await agencyCommissionService.transferPointsToAgent({
        senderUserId: userId,
        recipientAgentUserId: recipientAgency.userId,
        points,
        idempotencyKey,
      })
      return reply.status(201).send(result)
    },
  )

  app.get(
    '/transfer-points/history',
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const q = request.query as Record<string, string | undefined>
      const roleRaw = (q.role ?? 'all').toLowerCase()
      const role =
        roleRaw === 'sender' || roleRaw === 'recipient' || roleRaw === 'all' ? roleRaw : 'all'
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? '20') || 20))
      const offset = Math.max(0, Number(q.cursor ?? '0') || 0)
      const { agencyPointTransferRepository } =
        await import('../../repositories/agencyPointTransfer.repository')
      const rows = await agencyPointTransferRepository.listForUser(userId, {
        role,
        limit,
        offset,
      })
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      return reply.send({
        items: page.map((r) => ({
          id: r.id,
          senderAgentUserId: r.senderAgentUserId,
          recipientAgentUserId: r.recipientAgentUserId,
          points: r.points.toString(),
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? String(offset + limit) : null,
      })
    },
  )
}
