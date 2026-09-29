import type { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import {
  getQualifyingRewardEarningsByUserForRange,
  getQualifyingRewardEarningsForRange,
} from './rewardEarnings.repository'

export type NormalHostDailyTierInsert = {
  userId: string
  rewardDate: Date
  thresholdPoints: bigint | null
  hourlyRatePoints: bigint | null
  hourCapHours: number | null
  windowDays: number | null
  earningsByWindow: Record<string, string>
  source: 'job' | 'lazy'
}

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

  /** Primary, not replica: read right after a lazy insert must see it. */
  async getDailyTier(userId: string, rewardDate: Date) {
    return prisma.normalHostDailyTier.findUnique({
      where: { userId_rewardDate: { userId, rewardDate } },
    })
  },

  /** First write wins: a day's tier is never overwritten once recorded. */
  async insertDailyTiers(rows: NormalHostDailyTierInsert[]): Promise<number> {
    if (rows.length === 0) return 0
    const { count } = await prisma.normalHostDailyTier.createMany({
      data: rows,
      skipDuplicates: true,
    })
    return count
  },

  getQualifyingEarningsForRange: getQualifyingRewardEarningsForRange,
  getQualifyingEarningsByUserForRange: getQualifyingRewardEarningsByUserForRange,
}
