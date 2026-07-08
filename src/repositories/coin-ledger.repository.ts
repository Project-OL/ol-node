import { prismaRead } from '../config/database'
import { CoinTxType, LedgerDirection, Prisma } from '@prisma/client'

export type CoinLedgerFilter = {
  walletId: string
  types?: CoinTxType[]
  direction?: LedgerDirection
  from?: Date
  to?: Date
  cursor?: string
  limit: number
}

export const coinLedgerRepository = {
  async findByIdempotencyKey(tx: Prisma.TransactionClient, idempotencyKey: string) {
    return tx.coinLedgerEntry.findUnique({
      where: { idempotencyKey },
    })
  },

  async insert(
    tx: Prisma.TransactionClient,
    data: {
      walletId: string
      direction: LedgerDirection
      txType: CoinTxType
      amount: bigint
      balanceAfter: bigint
      refId?: string
      counterpartyId?: string
      description?: string
      metadata?: object
      idempotencyKey: string
    },
  ) {
    return tx.coinLedgerEntry.create({ data })
  },

  async list(filter: CoinLedgerFilter) {
    const createdAt: Prisma.DateTimeFilter = {}
    if (filter.from) createdAt.gte = filter.from
    if (filter.to) createdAt.lte = filter.to
    if (filter.cursor) {
      createdAt.lt = await coinLedgerRepository._getCreatedAt(filter.cursor)
    }

    const where: Prisma.CoinLedgerEntryWhereInput = {
      walletId: filter.walletId,
      ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      ...(filter.types?.length ? { txType: { in: filter.types } } : {}),
      ...(filter.direction ? { direction: filter.direction } : {}),
    }

    return prismaRead.coinLedgerEntry.findMany({
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
    // direction-adjusted SUM over the whole ledger.
    const last = await prismaRead.coinLedgerEntry.findFirst({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      select: { balanceAfter: true },
    })
    return last?.balanceAfter ?? 0n
  },

  async _getCreatedAt(id: string): Promise<Date> {
    const e = await prismaRead.coinLedgerEntry.findUniqueOrThrow({
      where: { id },
      select: { createdAt: true },
    })
    return e.createdAt
  },
}
