import type { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export const userSubscriberRepository = {
  async upsertPairInTx(
    tx: Prisma.TransactionClient,
    subscriberId: string,
    creatorId: string,
  ): Promise<void> {
    await tx.userSubscriber.upsert({
      where: {
        subscriberId_creatorId: { subscriberId, creatorId },
      },
      create: { subscriberId, creatorId },
      update: {},
    })
  },

  async upsertPair(subscriberId: string, creatorId: string): Promise<void> {
    await prisma.userSubscriber.upsert({
      where: {
        subscriberId_creatorId: { subscriberId, creatorId },
      },
      create: { subscriberId, creatorId },
      update: {},
    })
  },

  async deletePair(subscriberId: string, creatorId: string): Promise<void> {
    await prisma.userSubscriber.deleteMany({
      where: { subscriberId, creatorId },
    })
  },

  async countSubscribersForCreators(creatorIds: string[]): Promise<Map<string, number>> {
    if (creatorIds.length === 0) {
      return new Map()
    }
    const rows = await prismaRead.userSubscriber.groupBy({
      by: ['creatorId'],
      where: {
        creatorId: { in: creatorIds },
      },
      _count: {
        _all: true,
      },
    })
    const map = new Map<string, number>()
    for (const row of rows) {
      map.set(row.creatorId, row._count._all)
    }
    return map
  },
}
