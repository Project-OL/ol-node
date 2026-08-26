import { prismaRead } from '../config/database'

const sessionDurationSelect = {
  id: true,
  streamId: true,
  startedAt: true,
  endedAt: true,
  isLive: true,
  effectiveDurationSeconds: true,
} as const

export const liveStreamRepository = {
  /** All sessions for `userId` whose `startedAt` falls within `[dayStartUtc, dayEndUtc)`. */
  async getSessionsForUserOnDate(userId: string, dayStartUtc: Date, dayEndUtc: Date) {
    return prismaRead.liveStream.findMany({
      where: {
        userId,
        startedAt: { gte: dayStartUtc, lt: dayEndUtc },
      },
      select: sessionDurationSelect,
    })
  },

  /** All sessions for `userId` whose `startedAt` falls within `[rangeStartUtc, rangeEndUtc)`, spanning multiple calendar days. */
  async getSessionsForUserInRange(userId: string, rangeStartUtc: Date, rangeEndUtc: Date) {
    return prismaRead.liveStream.findMany({
      where: {
        userId,
        startedAt: { gte: rangeStartUtc, lt: rangeEndUtc },
      },
      select: sessionDurationSelect,
    })
  },
}
