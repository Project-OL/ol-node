import { prisma, prismaRead } from '../config/database'

export type LedgerFloatSnapshotInput = {
  snapshotAt: Date
  customerCoins: bigint
  customerTradingCoins: bigint
  customerHostPoints: bigint
  customerAgencyPoints: bigint
  customerTotal: bigint
  houseCoins: bigint
  houseTradingCoins: bigint
  housePoints: bigint
  houseTotal: bigint
  ledgerNet: bigint
  identityDelta: bigint
}

export const ledgerFloatSnapshotRepository = {
  /** Exact-instant lookup — period starts land on UTC day boundaries. */
  async findAt(snapshotAt: Date) {
    return prismaRead.ledgerFloatSnapshot.findUnique({ where: { snapshotAt } })
  },

  async upsert(data: LedgerFloatSnapshotInput) {
    const { snapshotAt, ...values } = data
    return prisma.ledgerFloatSnapshot.upsert({
      where: { snapshotAt },
      create: { snapshotAt, ...values },
      update: values,
    })
  },

  async listRecent(limit: number) {
    return prismaRead.ledgerFloatSnapshot.findMany({
      orderBy: { snapshotAt: 'desc' },
      take: limit,
    })
  },
}
