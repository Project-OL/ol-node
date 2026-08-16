import { prisma, prismaRead } from '../config/database'

export type PayrollFeeTierRow = {
  minPoints: bigint
  maxPoints: bigint | null
  platformFeeRateBp: number
  agentRewardRateBp: number
  sortOrder: number
}

export const payrollFeeTierRepository = {
  async findActive(): Promise<PayrollFeeTierRow[]> {
    return prismaRead.payrollFeeTier.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { minPoints: 'asc' }],
      select: {
        minPoints: true,
        maxPoints: true,
        platformFeeRateBp: true,
        agentRewardRateBp: true,
        sortOrder: true,
      },
    })
  },

  async softReplace(
    tiers: Array<{
      minPoints: bigint
      maxPoints: bigint | null
      platformFeeRateBp: number
      agentRewardRateBp: number
    }>,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await tx.payrollFeeTier.updateMany({ data: { isActive: false } })
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i]!
        await tx.payrollFeeTier.create({
          data: {
            minPoints: tier.minPoints,
            maxPoints: tier.maxPoints,
            platformFeeRateBp: tier.platformFeeRateBp,
            agentRewardRateBp: tier.agentRewardRateBp,
            sortOrder: i + 1,
            isActive: true,
          },
        })
      }
    })
  },

  async updateAgentRewardOnActive(agentRewardRateBp: number): Promise<void> {
    await prisma.payrollFeeTier.updateMany({
      where: { isActive: true },
      data: { agentRewardRateBp },
    })
  },
}
