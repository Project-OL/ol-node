import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CompanyCashDirection,
  CompanyCashReason,
  LedgerAccountRoleType,
  TreasuryFlowClassificationType,
  TreasuryFlowKind,
} from '@prisma/client'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminCashJournalCreateBodySchema,
  adminCashJournalQuerySchema,
  adminCurrencyAdjustBodySchema,
  adminCurrencyAdjustmentsQuerySchema,
  adminCurrencySupplySummaryQuerySchema,
  adminHouseAccountDeleteBodySchema,
  adminHouseAccountUpsertBodySchema,
  adminHouseAccountsQuerySchema,
  adminLedgerBreakageInvestigateQuerySchema,
  adminLedgerPeriodQuerySchema,
  adminLedgerReconciliationInvestigateQuerySchema,
  adminTreasuryFlowClassifyBodySchema,
  adminTreasuryFlowsQuerySchema,
} from '../../models/admin-currency.schemas'
import { adminCurrencyService } from '../../services/adminCurrency.service'
import { adminAuditMetaFromRequest } from '../../utils/admin-audit'
import { companyCashService } from '../../services/companyCash.service'
import { masterLedgerService } from '../../services/masterLedger.service'
import { masterLedgerInvestigateService } from '../../services/masterLedgerInvestigate.service'
import { ledgerAccountRoleService } from '../../services/ledgerAccountRole.service'
import { treasuryFlowService } from '../../services/treasuryFlow.service'
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
          'Unified mint/burn: credit or debit COIN, POINT, TRADING_COIN, or DIAMOND for a user in one request.',
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
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
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
        description:
          'Period operating P&L, cash P&L, inventory, and identity (today/yesterday/month/quarter/year/custom up to 730 days).',
      },
    },
    async (request, reply) => {
      const parsed = adminLedgerPeriodQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
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
    '/ledger/investigate/breakage',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'When Books balanced shows BREAKAGE, list wallets whose balance_after disagrees with ledger net, with users and recent entries.',
      },
    },
    async (request, reply) => {
      const parsed = adminLedgerBreakageInvestigateQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await masterLedgerInvestigateService.investigateBreakage({
          at: parsed.data.at ? new Date(parsed.data.at) : undefined,
        }),
      )
    },
  )

  app.get(
    '/ledger/investigate/reconciliation',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'When Sales vs usage shows DELTA, list investigation leads: unregistered treasury senders, returns to house, and large customer Adjustments.',
      },
    },
    async (request, reply) => {
      const parsed = adminLedgerReconciliationInvestigateQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await masterLedgerInvestigateService.investigateReconciliation({
          from: parsed.data.from ? new Date(parsed.data.from) : undefined,
          to: parsed.data.to ? new Date(parsed.data.to) : undefined,
          grain: parsed.data.grain,
        }),
      )
    },
  )

  app.get(
    '/ledger/house-accounts',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Registered house accounts (treasury + company agency). House balances are unsold inventory, not liabilities.',
      },
    },
    async (request, reply) => {
      const parsed = adminHouseAccountsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(await ledgerAccountRoleService.list(parsed.data.includeInactive))
    },
  )

  app.post(
    '/ledger/house-accounts',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Register or update a house account role (TREASURY, COMPANY_AGENCY, or GAME_HOUSE). A user can hold more than one role — e.g. an existing TREASURY account can also be registered as GAME_HOUSE. TREASURY/COMPANY_AGENCY require the user to be an agency agent so it can send trading coins; GAME_HOUSE does not.',
      },
    },
    async (request, reply) => {
      const parsed = adminHouseAccountUpsertBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminUserId = request.adminUser!.id
      const row = await ledgerAccountRoleService.upsert({
        adminUserId,
        userId: parsed.data.userId,
        role: parsed.data.role as LedgerAccountRoleType,
        label: parsed.data.label,
        note: parsed.data.note,
        effectiveFrom: parsed.data.effectiveFrom ? new Date(parsed.data.effectiveFrom) : undefined,
      })
      auditService.logAdmin({
        adminUserId,
        targetUserId: parsed.data.userId,
        actionType: 'ADMIN_LEDGER_HOUSE_ACCOUNT_UPSERT',
        actionStatus: 'success',
        actionDetails: { role: parsed.data.role, label: parsed.data.label ?? null },
        request: adminAuditMetaFromRequest(request),
      })
      return reply.send(row)
    },
  )

  app.delete(
    '/ledger/house-accounts/:userId',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Deactivate a house account role. Refused while the account still holds units unless force is set.',
      },
    },
    async (request, reply) => {
      const { userId } = request.params as { userId: string }
      const parsed = adminHouseAccountDeleteBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminUserId = request.adminUser!.id
      const result = await ledgerAccountRoleService.deactivate({
        userId,
        role: parsed.data.role,
        force: parsed.data.force,
      })
      auditService.logAdmin({
        adminUserId,
        targetUserId: userId,
        actionType: 'ADMIN_LEDGER_HOUSE_ACCOUNT_REMOVE',
        actionStatus: 'success',
        actionDetails: { role: result.role, force: parsed.data.force === true },
        request: adminAuditMetaFromRequest(request),
      })
      return reply.send(result)
    },
  )

  app.get(
    '/ledger/treasury-flows',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Treasury outflows with their effective classification. No override means SALE; a house recipient is always INTERNAL.',
      },
    },
    async (request, reply) => {
      const parsed = adminTreasuryFlowsQuerySchema.safeParse(request.query ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
      }
      return reply.send(
        await treasuryFlowService.list({
          from: parsed.data.from ? new Date(parsed.data.from) : undefined,
          to: parsed.data.to ? new Date(parsed.data.to) : undefined,
          classification: parsed.data.classification as TreasuryFlowClassificationType | undefined,
          senderUserId: parsed.data.senderUserId,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
        }),
      )
    },
  )

  app.post(
    '/ledger/treasury-flows/classify',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Currency'],
        description:
          'Reclassify a treasury outflow as SALE, PROMO, or WRITE_OFF. Overrides are stored only when they differ from the SALE default.',
      },
    },
    async (request, reply) => {
      const parsed = adminTreasuryFlowClassifyBodySchema.safeParse(request.body ?? {})
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
      }
      const adminUserId = request.adminUser!.id
      const result = await treasuryFlowService.classify({
        adminUserId,
        flowKind: parsed.data.flowKind as TreasuryFlowKind,
        flowId: parsed.data.flowId,
        classification: parsed.data.classification as TreasuryFlowClassificationType,
        reason: parsed.data.reason,
      })
      auditService.logAdmin({
        adminUserId,
        actionType: 'ADMIN_TREASURY_FLOW_CLASSIFY',
        actionStatus: 'success',
        actionDetails: {
          flowKind: parsed.data.flowKind,
          flowId: parsed.data.flowId,
          classification: parsed.data.classification,
        },
        request: adminAuditMetaFromRequest(request),
      })
      return reply.send(result)
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
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid query',
          'INVALID_REQUEST',
        )
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
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? 'Invalid body',
          'INVALID_REQUEST',
        )
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
