import type { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { getQualifyingRewardEarningsForRange } from './rewardEarnings.repository'

export const normalHostRewardRepository = {
  async getClaimsForDate(userId: string, rewardDate: Date) {
    return prismaRead.normalHostRewardClaim.findMany({
      where: { userId, rewardDate },
      select: { hourSlot: true, pointsAmount: true, tierThresholdPoints: true, claimedAt: true },
    })
  },

  async insertClaim(
    data: {
      userId: string
      rewardDate: Date
      hourSlot: number
      pointsAmount: bigint
      tierThresholdPoints: bigint
      ledgerEntryId: string
    },
    tx: Prisma.TransactionClient = prisma,
  ) {
    return tx.normalHostRewardClaim.create({ data })
  },

  getQualifyingEarningsForRange: getQualifyingRewardEarningsForRange,
}
