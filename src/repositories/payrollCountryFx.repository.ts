import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type PayrollCountryFxRow = {
  country: string
  countryCode: string | null
  currencyCode: string
  ratePerUsd: Prisma.Decimal
  sortOrder: number
}

export const payrollCountryFxRepository = {
  async findActive(): Promise<PayrollCountryFxRow[]> {
    return prismaRead.payrollCountryFxRate.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { country: 'asc' }],
      select: {
        country: true,
        countryCode: true,
        currencyCode: true,
        ratePerUsd: true,
        sortOrder: true,
      },
    })
  },

  async upsertActive(
    rows: Array<{
      country: string
      countryCode: string | null
      currencyCode: string
      ratePerUsd: Prisma.Decimal
    }>,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.payrollCountryFxRate.findMany({
        select: { id: true, country: true },
      })
      const keep = new Set(rows.map((r) => r.country.toLowerCase()))

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!
        const found = existing.find((e) => e.country.toLowerCase() === row.country.toLowerCase())
        if (found) {
          await tx.payrollCountryFxRate.update({
            where: { id: found.id },
            data: {
              country: row.country,
              countryCode: row.countryCode,
              currencyCode: row.currencyCode,
              ratePerUsd: row.ratePerUsd,
              sortOrder: i + 1,
              isActive: true,
            },
          })
        } else {
          await tx.payrollCountryFxRate.create({
            data: {
              country: row.country,
              countryCode: row.countryCode,
              currencyCode: row.currencyCode,
              ratePerUsd: row.ratePerUsd,
              sortOrder: i + 1,
              isActive: true,
            },
          })
        }
      }

      const deactivateIds = existing
        .filter((e) => !keep.has(e.country.toLowerCase()))
        .map((e) => e.id)
      if (deactivateIds.length) {
        await tx.payrollCountryFxRate.updateMany({
          where: { id: { in: deactivateIds } },
          data: { isActive: false },
        })
      }
    })
  },
}
