import { Prisma, type PaymentChannel, type PaymentTxnKind } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { epayBookkeeping } from './epay-bookkeeping'

/**
 * The payment transaction list: one row per money event with an outside provider
 * (Epay, Google Play, Apple) — purchases, refunds, payouts, payout reversals.
 *
 * Rows are written INSIDE the transaction that moves the coins / points, so the list never
 * disagrees with the ledger. `(channel, kind, externalId)` is unique and inserts use
 * ON CONFLICT DO NOTHING, so recording the same provider event twice is a no-op (and the
 * caller learns it was a duplicate).
 */

export type PaymentWalletCurrency = 'COIN' | 'TRADING_COIN' | 'POINT'

export interface PaymentTxnInput {
  channel: PaymentChannel
  kind: PaymentTxnKind
  status: string
  externalId: string
  providerRef?: string | null
  parentId?: string | null
  userId: string
  walletCurrency: PaymentWalletCurrency
  amount: Prisma.Decimal | string | number
  currency: string
  units?: bigint | null
  sourceTable?: string | null
  sourceId?: string | null
  ledgerEntryId?: string | null
  reason?: string | null
  metadata?: Prisma.InputJsonValue | null
  occurredAt: Date
}

function toData(input: PaymentTxnInput): Prisma.PaymentTransactionCreateManyInput {
  return {
    channel: input.channel,
    kind: input.kind,
    status: input.status,
    externalId: input.externalId.slice(0, 128),
    providerRef: input.providerRef ? input.providerRef.slice(0, 128) : null,
    parentId: input.parentId ?? null,
    userId: input.userId,
    walletCurrency: input.walletCurrency,
    amount: new Prisma.Decimal(input.amount.toString()),
    currency: input.currency.toUpperCase().slice(0, 10),
    units: input.units ?? null,
    sourceTable: input.sourceTable ?? null,
    sourceId: input.sourceId ?? null,
    ledgerEntryId: input.ledgerEntryId ?? null,
    reason: input.reason ?? null,
    metadata: input.metadata ?? undefined,
    occurredAt: input.occurredAt,
  }
}

export interface PaymentTxnListQuery {
  channel?: PaymentChannel
  kind?: PaymentTxnKind
  status?: string
  userId?: string
  externalId?: string
  from?: Date
  to?: Date
  /** Opaque cursor from the previous page (`nextCursor`). */
  cursor?: string
  limit: number
}

function encodeCursor(row: { occurredAt: Date; id: string }): string {
  return Buffer.from(`${row.occurredAt.toISOString()}|${row.id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    const occurredAt = new Date(iso ?? '')
    if (!id || Number.isNaN(occurredAt.getTime())) return null
    return { occurredAt, id }
  } catch {
    return null
  }
}

export const paymentTransactionsService = {
  /**
   * Insert one row inside the caller's transaction. Returns the new row's id, or `null` when a
   * row with the same (channel, kind, externalId) already exists (the event was recorded before).
   */
  async recordInTx(tx: Prisma.TransactionClient, input: PaymentTxnInput): Promise<string | null> {
    const rows = await tx.paymentTransaction.createManyAndReturn({
      data: [toData(input)],
      skipDuplicates: true,
      select: { id: true },
    })
    return rows[0]?.id ?? null
  },

  /** Record a confirmed Epay payout (from `epay_payout_orders`). Idempotent. */
  async recordEpayPayoutSuccess(payoutOrderId: string): Promise<void> {
    const p = await prisma.epayPayoutOrder.findUnique({ where: { id: payoutOrderId } })
    if (!p || p.status !== 'SUCCESS') return
    const w = await prisma.withdrawal.findUnique({
      where: { id: p.withdrawalId },
      select: { userId: true, amountPoints: true },
    })
    if (!w) return
    await prisma.$transaction(async (tx) => {
      const id = await paymentTransactionsService.recordInTx(tx, {
        channel: 'EPAY',
        kind: 'PAYOUT',
        status: 'SUCCEEDED',
        externalId: p.merchantOrderNo,
        providerRef: p.epayOrderNo,
        userId: w.userId,
        walletCurrency: 'POINT',
        amount: p.amount,
        currency: p.currency,
        units: w.amountPoints,
        sourceTable: 'epay_payout_orders',
        sourceId: p.id,
        metadata: {
          withdrawalId: p.withdrawalId,
          fee: p.fee?.toString() ?? null,
          receiveEpayAccount: p.receiveEpayAccount,
        },
        occurredAt: p.completedAt ?? new Date(),
      })
      // First recording only: the fee is booked exactly once, with the row.
      if (id) {
        await epayBookkeeping.fee(tx, {
          fee: p.fee,
          counterpartyUserId: w.userId,
          ledgerRefId: p.merchantOrderNo,
          withdrawalId: p.withdrawalId,
          description: 'Epay payout fee',
        })
      }
    })
  },

  async findOne(
    db: Prisma.TransactionClient | typeof prismaRead,
    channel: PaymentChannel,
    kind: PaymentTxnKind,
    externalId: string,
  ) {
    return db.paymentTransaction.findUnique({
      where: { channel_kind_externalId: { channel, kind, externalId } },
    })
  },

  /**
   * Admin list, newest first, keyset-paginated on (occurredAt, id) so deep pages stay one index
   * range scan no matter how large the table grows.
   */
  async list(q: PaymentTxnListQuery) {
    const where: Prisma.PaymentTransactionWhereInput = {
      ...(q.channel && { channel: q.channel }),
      ...(q.kind && { kind: q.kind }),
      ...(q.status && { status: q.status }),
      ...(q.userId && { userId: q.userId }),
      ...(q.externalId && { externalId: q.externalId }),
      ...((q.from || q.to) && {
        occurredAt: { ...(q.from && { gte: q.from }), ...(q.to && { lt: q.to }) },
      }),
    }
    const after = q.cursor ? decodeCursor(q.cursor) : null
    if (after) {
      where.AND = [
        {
          OR: [
            { occurredAt: { lt: after.occurredAt } },
            { occurredAt: after.occurredAt, id: { lt: after.id } },
          ],
        },
      ]
    }
    const rows = await prismaRead.paymentTransaction.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    })
    const page = rows.slice(0, q.limit)
    const userIds = [...new Set(page.map((r) => r.userId))]
    const users = userIds.length
      ? await prismaRead.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            originalPublicId: true,
            firstName: true,
            lastName: true,
            status: true,
          },
        })
      : []
    const byId = new Map(users.map((u) => [u.id, u]))
    return {
      items: page.map((r) => {
        const u = byId.get(r.userId)
        return {
          id: r.id,
          channel: r.channel,
          kind: r.kind,
          status: r.status,
          externalId: r.externalId,
          providerRef: r.providerRef,
          parentId: r.parentId,
          userId: r.userId,
          user: u
            ? {
                publicId: u.originalPublicId?.toString() ?? null,
                name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
                status: u.status,
              }
            : null,
          walletCurrency: r.walletCurrency,
          amount: r.amount.toString(),
          currency: r.currency,
          units: r.units?.toString() ?? null,
          sourceTable: r.sourceTable,
          sourceId: r.sourceId,
          reason: r.reason,
          metadata: r.metadata,
          occurredAt: r.occurredAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
        }
      }),
      nextCursor: rows.length > q.limit ? encodeCursor(page[page.length - 1]!) : null,
    }
  },
}
