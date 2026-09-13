import type { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

export const DEFAULT_ROYAL_HOST_WEEKLY_HOURS_REQUIRED = 14
export const DEFAULT_ROYAL_HOST_DAILY_HOURS_CAP_MINUTES = 180
export const DEFAULT_ROYAL_HOST_TIMING_STEP1_POINTS = 40_000n
export const DEFAULT_ROYAL_HOST_TIMING_STEP2_POINTS = 60_000n
export const DEFAULT_ROYAL_HOST_TIMING_STEP2_EARNING_THRESHOLD = 1_000_000n
export const DEFAULT_ROYAL_HOST_CONSECUTIVE_MISS_WEEKS_LIMIT = 3
export const DEFAULT_ROYAL_HOST_AUTO_REVOKE_EARNING_THRESHOLD = 1_000_000n
export const DEFAULT_ROYAL_HOST_GIFTING_TIERS = [
  { threshold: '1000000', cumulativePoints: '60000' },
  { threshold: '3000000', cumulativePoints: '200000' },
  { threshold: '5000000', cumulativePoints: '400000' },
  { threshold: '10000000', cumulativePoints: '900000' },
]

export const royalHostRewardConfigRepository = {
  async getOrCreate() {
    return prisma.royalHostRewardConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        weeklyHoursRequired: DEFAULT_ROYAL_HOST_WEEKLY_HOURS_REQUIRED,
        dailyHoursCapMinutes: DEFAULT_ROYAL_HOST_DAILY_HOURS_CAP_MINUTES,
        timingStep1Points: DEFAULT_ROYAL_HOST_TIMING_STEP1_POINTS,
        timingStep2Points: DEFAULT_ROYAL_HOST_TIMING_STEP2_POINTS,
        timingStep2EarningThreshold: DEFAULT_ROYAL_HOST_TIMING_STEP2_EARNING_THRESHOLD,
        giftingTiers: DEFAULT_ROYAL_HOST_GIFTING_TIERS,
        consecutiveMissWeeksLimit: DEFAULT_ROYAL_HOST_CONSECUTIVE_MISS_WEEKS_LIMIT,
        autoRevokeEarningThreshold: DEFAULT_ROYAL_HOST_AUTO_REVOKE_EARNING_THRESHOLD,
      },
      update: {},
    })
  },

  async update(data: Prisma.RoyalHostRewardConfigUpdateInput) {
    return prisma.royalHostRewardConfig.update({
      where: { id: 1 },
      data,
    })
  },
}
