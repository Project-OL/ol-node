import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { CompanyCashDirection, CompanyCashReason } from '@prisma/client'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminCashJournalCreateBodySchema,
  adminCashJournalQuerySchema,
  adminCurrencyAdjustBodySchema,
  adminCurrencyAdjustmentsQuerySchema,
  adminCurrencySupplySummaryQuerySchema,
  adminLedgerPeriodQuerySchema,
} from '../../models/admin-currency.schemas'
import { adminCurrencyService } from '../../services/adminCurrency.service'
import { adminAuditMetaFromRequest } from '../../utils/admin-audit'
import { companyCashService } from '../../services/companyCash.service'
import { masterLedgerService } from '../../services/masterLedger.service'
import { auditService } from '../../services/audit.service'

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

  app.get(
    '/ledger/stock',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description: 'Wallet inventory + identity check at `at` (default now).',
      },
    },
    async (request, reply) => {
      const parsed = adminLedgerPeriodQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
      }
      const at = parsed.data.at ? new Date(parsed.data.at) : new Date()
      return reply.send(await masterLedgerService.stock(at))
    },
  )

  app.get(
    '/ledger/pnl',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description: 'Period operating P&L, cash P&L, inventory, and identity (month/quarter/year).',
      },
    },
    async (request, reply) => {
      const parsed = adminLedgerPeriodQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
      }
      return reply.send(
        await masterLedgerService.dashboard({
          from: parsed.data.from ? new Date(parsed.data.from) : undefined,
          to: parsed.data.to ? new Date(parsed.data.to) : undefined,
          grain: parsed.data.grain,
          at: parsed.data.at ? new Date(parsed.data.at) : undefined,
        }),
      )
    },
  )

  app.get(
    '/currency/cash-journal',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description: 'Paginated company cash journal (off-system receipts and company payouts).',
      },
    },
    async (request, reply) => {
      const parsed = adminCashJournalQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
      }
      return reply.send(
        await companyCashService.list({
          from: parsed.data.from ? new Date(parsed.data.from) : undefined,
          to: parsed.data.to ? new Date(parsed.data.to) : undefined,
          reason: parsed.data.reason,
          direction: parsed.data.direction,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
        }),
      )
    },
  )

  app.post(
    '/currency/cash-journal',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description: 'Manually record an off-system cash in/out row.',
      },
    },
    async (request, reply) => {
      const parsed = adminCashJournalCreateBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
      }
      const adminUserId = request.adminUser!.id
      const row = await companyCashService.record({
        direction: parsed.data.direction as CompanyCashDirection,
        reason: parsed.data.reason as CompanyCashReason,
        amountUsd: parsed.data.amountUsd,
        unitsAmount: parsed.data.unitsAmount ? BigInt(parsed.data.unitsAmount) : null,
        counterpartyUserId: parsed.data.counterpartyUserId ?? null,
        ledgerRefId: parsed.data.ledgerRefId ?? null,
        withdrawalId: parsed.data.withdrawalId ?? null,
        description: parsed.data.description ?? null,
        adminUserId,
      })
      auditService.logAdmin({
        adminUserId,
        actionType: 'ADMIN_CASH_JOURNAL_CREATE',
        actionStatus: 'success',
        actionDetails: {
          id: row.id,
          direction: row.direction,
          reason: row.reason,
          amountUsd: parsed.data.amountUsd,
        },
        request: adminAuditMetaFromRequest(request),
      })
      return reply.send({
        ok: true,
        id: row.id,
        createdAt: row.createdAt.toISOString(),
      })
    },
  )
}
