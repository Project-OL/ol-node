import { prisma, prismaRead } from '../config/database'

export const videoCallPriceCapRepository = {
  async findActive() {
    return prismaRead.videoCallPriceCap.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { price: 'asc' }],
    })
  },

  async softReplace(
    tiers: Array<{
      minLevel: number
      maxLevel: number | null
      price: number
      label?: string | null
    }>,
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.videoCallPriceCap.updateMany({ data: { isActive: false } })
      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i]!
        await tx.videoCallPriceCap.create({
          data: {
            minLevel: tier.minLevel,
            maxLevel: tier.maxLevel,
            price: tier.price,
            label: tier.label ?? null,
            sortOrder: i + 1,
            isActive: true,
          },
        })
      }
    })
  },
}
