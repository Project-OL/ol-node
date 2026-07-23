import { prismaRead } from '../config/database'

export const liveStreamRepository = {
  /** All sessions for `userId` whose `startedAt` falls within `[dayStartUtc, dayEndUtc)`. */
  async getSessionsForUserOnDate(userId: string, dayStartUtc: Date, dayEndUtc: Date) {
    return prismaRead.liveStream.findMany({
      where: {
        userId,
        startedAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
      select: { id: true, startedAt: true, endedAt: true, isLive: true },
    })
  },
}
