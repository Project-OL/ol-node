import { prisma, prismaRead } from '../config/database'

export type OtpCostRateRow = {
  id: string
  means: string
  country: string
  rateMinor: number
  currency: string
  updatedAt: Date
  updatedByUserId: string | null
}

export const otpCostRateRepository = {
  async findAll(): Promise<OtpCostRateRow[]> {
    return prismaRead.otpCostRate.findMany({ orderBy: [{ means: 'asc' }, { country: 'asc' }] })
  },

  async upsert(params: {
    means: string
    country: string
    rateMinor: number
    currency: string
    updatedByUserId?: string | null
  }): Promise<OtpCostRateRow> {
    return prisma.otpCostRate.upsert({
      where: { means_country: { means: params.means, country: params.country } },
      create: {
        means: params.means,
        country: params.country,
        rateMinor: params.rateMinor,
        currency: params.currency,
        updatedByUserId: params.updatedByUserId ?? undefined,
      },
      update: {
        rateMinor: params.rateMinor,
        currency: params.currency,
        updatedByUserId: params.updatedByUserId ?? undefined,
      },
    })
  },

  async delete(means: string, country: string): Promise<void> {
    await prisma.otpCostRate
      .delete({ where: { means_country: { means, country } } })
      .catch(() => null)
  },
}
