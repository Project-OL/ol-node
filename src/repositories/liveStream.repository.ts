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

  /** All sessions for `userId` whose `startedAt` falls within `[rangeStartUtc, rangeEndUtc)`, spanning multiple calendar days. */
  async getSessionsForUserInRange(userId: string, rangeStartUtc: Date, rangeEndUtc: Date) {
    return prismaRead.liveStream.findMany({
      where: {
        userId,
        startedAt: { gte: rangeStartUtc, lt: rangeEndUtc },
      },
      select: { id: true, startedAt: true, endedAt: true, isLive: true },
    })
  },
}
