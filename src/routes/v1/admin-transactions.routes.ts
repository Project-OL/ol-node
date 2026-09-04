import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import {
  adminTransactionRevertBodySchema,
  adminTransactionsListQuerySchema,
  adminPlatformProfitSummaryQuerySchema,
} from '../../models/admin-transactions.schemas'
import { adminTransactionsService } from '../../services/adminTransactions.service'

const preAuth = [authenticateAdmin]

function parseListQuery(query: unknown) {
  const parsed = adminTransactionsListQuerySchema.safeParse(query ?? {})
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
  }
  return parsed.data
}

function parseProfitSummaryQuery(query: unknown) {
  const parsed = adminPlatformProfitSummaryQuerySchema.safeParse(query ?? {})
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
  }
  return parsed.data
}

function parseRevertBody(body: unknown) {
  const parsed = adminTransactionRevertBodySchema.safeParse(body ?? {})
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid body', 'INVALID_REQUEST')
  }
  return parsed.data
}

export default async function adminTransactionsRoutes(app: FastifyInstance) {
  // ── Lists ─────────────────────────────────────────────────────────────

  app.get(
    '/transactions/platform-profit/summary',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Platform profit totals (coins / points / trading coins) for an optional date window. Net of agency commission on coin→point flows.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.getPlatformProfitSummary(
          parseProfitSummaryQuery(request.query),
        ),
      )
    },
  )

  app.get(
    '/transactions/coins',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Global personal-coin ledger history with linked users, gifts, store, VIP, trading transfer refs. Filter/search by id, userId, publicId, q, types, dates.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(
        await adminTransactionsService.listCoinTransactions(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/points',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'Global point ledger history with counterparties and gift links.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listPointTransactions(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/trading-coins',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Global TRADING_COIN ledger history (top-ups, admin adjust, agent transfer debits, reversals). Filter with `direction=credit|debit`. `id` / `q` / `transferId` also match a `coin_trading_transfers` row and resolve to the agent debit ledger entry. Nested `coinTradingTransfer` is present on transfer-linked rows. Revert still uses `revertVia` (ledger or transfer POST).',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listTradingCoinLedger(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/game-diamonds',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Global DIAMOND ledger history (purchases, redemptions, game wagers/results/refunds). Includes the GAME_HOUSE counterparty wallet — its net balance growth over a period is the imputed game revenue line. Filter with `direction=credit|debit`.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listDiamondLedger(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/coin-trading-transfers',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'Coin trading transfer records (agent → user) with both parties.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listCoinTradingTransfers(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/gifts',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'Gift send history with sender, receiver, and catalog gift.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listGiftTransactions(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/subscriptions',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'Creator subscription purchases (subscriber + creator).',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listSubscriptions(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/vip-purchases',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'VIP membership purchase history with ledger link.',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listVipPurchases(parseListQuery(request.query)),
      )
    },
  )

  app.get(
    '/transactions/store-purchases',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'Store item purchase history (buyer, recipient, catalog item).',
      },
    },
    async (request, reply) => {
      return reply.send(
        await adminTransactionsService.listStorePurchases(parseListQuery(request.query)),
      )
    },
  )

  // ── Reverts ───────────────────────────────────────────────────────────

  app.post<{ Params: { ledgerEntryId: string } }>(
    '/transactions/coins/:ledgerEntryId/revert',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Revert a TRADING_COIN peer ledger entry only: debit receiver, then credit sender. Personal COIN rows return NOT_REVERTABLE — use gift or coin-trading-transfer revert instead.',
      },
    },
    async (request, reply) => {
      const body = parseRevertBody(request.body)
      return reply.send(
        await adminTransactionsService.revertCoinLedgerEntry({
          ledgerEntryId: request.params.ledgerEntryId,
          adminUserId: request.adminUser!.id,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        }),
      )
    },
  )

  app.post<{ Params: { ledgerEntryId: string } }>(
    '/transactions/points/:ledgerEntryId/revert',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description: 'Revert a point peer ledger entry: debit receiver, then credit sender.',
      },
    },
    async (request, reply) => {
      const body = parseRevertBody(request.body)
      return reply.send(
        await adminTransactionsService.revertPointLedgerEntry({
          ledgerEntryId: request.params.ledgerEntryId,
          adminUserId: request.adminUser!.id,
          reason: body.reason,
          idempotencyKey: body.idempotencyKey,
        }),
      )
    },
  )

  app.post<{ Params: { transferId: string } }>(
    '/transactions/coin-trading-transfers/:transferId/revert',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Revert a coin-trading transfer: debit recipient wallet first, then credit agent trading coins.',
      },
    },
    async (request, reply) => {
      const body = parseRevertBody(request.body)
      return reply.send(
        await adminTransactionsService.revertCoinTradingTransfer({
          transferId: request.params.transferId,
          adminUserId: request.adminUser!.id,
          reason: body.reason,
        }),
      )
    },
  )

  app.post<{ Params: { giftTransactionId: string } }>(
    '/transactions/gifts/:giftTransactionId/revert',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Transactions'],
        description:
          'Revert a gift: debit points from receiver first, then credit coins to sender.',
      },
    },
    async (request, reply) => {
      const body = parseRevertBody(request.body)
      return reply.send(
        await adminTransactionsService.revertGiftTransaction({
          giftTransactionId: request.params.giftTransactionId,
          adminUserId: request.adminUser!.id,
          reason: body.reason,
        }),
      )
    },
  )
}
