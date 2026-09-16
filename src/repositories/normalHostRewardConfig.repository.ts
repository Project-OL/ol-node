import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const DEFAULT_NORMAL_HOST_REWARD_TIERS = [
  { thresholdPoints: '100000', hourlyRatePoints: '1000', hourCapHours: 1, windowDays: 30 },
  { thresholdPoints: '300000', hourlyRatePoints: '2000', hourCapHours: 2, windowDays: 7 },
  { thresholdPoints: '500000', hourlyRatePoints: '3500', hourCapHours: 2, windowDays: 7 },
  { thresholdPoints: '1000000', hourlyRatePoints: '7000', hourCapHours: 2, windowDays: 7 },
  { thresholdPoints: '2000000', hourlyRatePoints: '14000', hourCapHours: 2, windowDays: 7 },
  { thresholdPoints: '4000000', hourlyRatePoints: '20000', hourCapHours: 3, windowDays: 7 },
  { thresholdPoints: '10000000', hourlyRatePoints: '50000', hourCapHours: 3, windowDays: 7 },
  { thresholdPoints: '22000000', hourlyRatePoints: '100000', hourCapHours: 3, windowDays: 7 },
  { thresholdPoints: '35000000', hourlyRatePoints: '170000', hourCapHours: 3, windowDays: 7 },
  { thresholdPoints: '50000000', hourlyRatePoints: '250000', hourCapHours: 3, windowDays: 7 },
]

export const normalHostRewardConfigRepository = {
  async getOrCreate() {
    return prisma.normalHostRewardConfig.upsert({
      where: { id: 1 },
      create: { id: 1, tiers: DEFAULT_NORMAL_HOST_REWARD_TIERS },
      update: {},
    })
  },

  async update(data: Prisma.NormalHostRewardConfigUpdateInput) {
    return prisma.normalHostRewardConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
