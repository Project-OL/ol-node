import { prismaRead } from '../config/database'
import { PointTxType, LedgerDirection, Prisma } from '@prisma/client'
import {
  matchesPointTransactionOrderNumber,
  parseOrderNumberTimestamp,
} from '../utils/point-transaction-order'

export type PointLedgerFilter = {
  walletId: string
  types?: PointTxType[]
  from?: Date
  to?: Date
  cursor?: string
  limit: number
}

export const pointLedgerRepository = {
  async findByIdempotencyKey(tx: Prisma.TransactionClient, idempotencyKey: string) {
    return tx.pointLedgerEntry.findUnique({
      where: { idempotencyKey },
    })
  },

  async insert(
    tx: Prisma.TransactionClient,
    data: {
      walletId: string
      direction: LedgerDirection
      txType: PointTxType
      amount: bigint
      balanceAfter: bigint
      refId?: string
      counterpartyId?: string
      description?: string
      metadata?: object
      idempotencyKey: string
    },
  ) {
    return tx.pointLedgerEntry.create({ data })
  },

  async findByIdForWallet(entryId: string, walletId: string) {
    return prismaRead.pointLedgerEntry.findFirst({
      where: { id: entryId, walletId },
    })
  },

  /** All ledger rows for this wallet matching canonical business refId. */
  async findByOrderNumberForWallet(walletId: string, orderNumber: string) {
    const anchor = parseOrderNumberTimestamp(orderNumber)
    if (!anchor) return null

    const from = new Date(anchor.getTime() - 2_000)
    const to = new Date(anchor.getTime() + 2_000)

    const candidates = await prismaRead.pointLedgerEntry.findMany({
      where: {
        walletId,
        createdAt: { gte: from, lte: to },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })

    return (
      candidates.find((entry) =>
        matchesPointTransactionOrderNumber(entry.id, entry.createdAt, orderNumber),
      ) ?? null
    )
  },

  async findByRefForWallet(walletId: string, refId: string) {
    const byColumn = await prismaRead.pointLedgerEntry.findMany({
      where: { walletId, refId },
      orderBy: { createdAt: 'desc' },
    })
    if (byColumn.length > 0) return byColumn

    return prismaRead.pointLedgerEntry.findMany({
      where: {
        walletId,
        OR: [
          { metadata: { path: ['transferId'], equals: refId } },
          { metadata: { path: ['withdrawalId'], equals: refId } },
          { metadata: { path: ['subscriptionId'], equals: refId } },
          { metadata: { path: ['exchangeRefId'], equals: refId } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  async list(filter: PointLedgerFilter) {
    const createdAt: Prisma.DateTimeFilter = {}
    if (filter.from) createdAt.gte = filter.from
    if (filter.to) createdAt.lte = filter.to
    if (filter.cursor) {
      createdAt.lt = await pointLedgerRepository._getCreatedAt(filter.cursor)
    }

    const where: Prisma.PointLedgerEntryWhereInput = {
      walletId: filter.walletId,
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      ...(filter.types?.length ? { txType: { in: filter.types } } : {}),
    }

    return prismaRead.pointLedgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: filter.limit + 1,
      include: {
        wallet: { select: { userId: true } },
      },
    })
  },

  async computeBalance(walletId: string): Promise<bigint> {
    // O(1) tail read: every write persists the running balance in balance_after
    // under the wallet FOR UPDATE lock, so the newest row's snapshot equals the
    // escrow-excluded SUM. WITHDRAWAL_ESCROW is a SOFT marker (in-flight escrow):
    // its rows carry the previous running balance forward unchanged, so it does
    // not reduce the ledger sum (totalPoints); availability is derived separately
    // as totalPoints - wallets.unconfirmedPoints. The real debit happens at
    // settlement via WITHDRAWAL_ESCROW_SETTLED.
    const last = await prismaRead.pointLedgerEntry.findFirst({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    })
    return last?.balanceAfter ?? 0n
  },

  async _getCreatedAt(id: string): Promise<Date> {
    const e = await prismaRead.pointLedgerEntry.findUniqueOrThrow({
      where: { id },
      select: { createdAt: true },
    })
    return e.createdAt
  },
}
