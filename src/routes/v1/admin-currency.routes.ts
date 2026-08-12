import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminCurrencyAdjustBodySchema,
  adminCurrencyAdjustmentsQuerySchema,
  adminCurrencySupplySummaryQuerySchema,
} from '../../models/admin-currency.schemas'
import { adminCurrencyService } from '../../services/adminCurrency.service'
import { adminAuditMetaFromRequest } from '../../utils/admin-audit'

const preAuth = [authenticateAdmin]

export default async function adminCurrencyRoutes(app: FastifyInstance) {
  app.post(
    '/currency/adjust',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Unified mint/burn: credit or debit COIN, POINT, or TRADING_COIN for a user in one request.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = adminCurrencyAdjustBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await adminCurrencyService.adjust({
          adminUserId: request.adminUser!.id,
          body: parsed.data,
          auditMeta: adminAuditMetaFromRequest(request),
        }),
      )
    },
  )

  app.get(
    '/currency/supply-summary',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Admin ADJUSTMENT totals: created (credits) vs returned (debits) for coins, points, trading coins.',
      },
    },
    async (request, reply) => {
      const parsed = adminCurrencySupplySummaryQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await adminCurrencyService.supplySummary(parsed.data))
    },
  )

  app.get(
    '/currency/adjustments',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description: 'Paginated admin ADJUSTMENT ledger across currencies (created / returned).',
      },
    },
    async (request, reply) => {
      const parsed = adminCurrencyAdjustmentsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await adminCurrencyService.listAdjustments(parsed.data))
    },
  )
}
