import { prismaRead } from '../config/database'

export const userSubscriberRepository = {
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

