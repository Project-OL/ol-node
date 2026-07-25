import type { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

export const livestreamRewardRepository = {
  async getClaim(userId: string, claimDate: Date, part: number) {
    return prismaRead.liveStreamRewardClaim.findUnique({
      where: { userId_claimDate_part: { userId, claimDate, part } },
    })
  },

  async getClaimsForDate(userId: string, claimDate: Date) {
    return prismaRead.liveStreamRewardClaim.findMany({
      where: { userId, claimDate },
    })
  },

  /** All claims for `userId` whose `claimDate` falls within `[fromDate, toDateExclusive)`. */
  async getClaimsForDateRange(userId: string, fromDate: Date, toDateExclusive: Date) {
    return prismaRead.liveStreamRewardClaim.findMany({
      where: { userId, claimDate: { gte: fromDate, lt: toDateExclusive } },
    })
  },

  async insertClaim(
    row: {
      userId: string
      claimDate: Date
      part: number
      pointsAmount: bigint
      ledgerEntryId: string
    },
    tx: Prisma.TransactionClient,
  ) {
    return tx.liveStreamRewardClaim.create({
      data: {
        userId: row.userId,
        claimDate: row.claimDate,
        part: row.part,
        pointsAmount: row.pointsAmount,
        ledgerEntryId: row.ledgerEntryId,
      },
    })
  },
}
