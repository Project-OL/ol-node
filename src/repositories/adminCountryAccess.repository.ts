import { prisma, prismaRead } from '../config/database'

export const adminCountryAccessRepository = {
  async listForAdmin(adminId: string): Promise<string[]> {
    const rows = await prismaRead.adminCountryAccess.findMany({
      where: { adminId },
      select: { country: true },
      orderBy: { country: 'asc' },
    })
    return rows.map((r) => r.country)
  },

  /** Replace the target admin's granted-country set entirely (tx: deleteMany + createMany). */
  async replaceForAdmin(
    adminId: string,
    countries: string[],
    createdByAdminId: string,
  ): Promise<void> {
    await prisma.$transaction([
      prisma.adminCountryAccess.deleteMany({ where: { adminId } }),
      ...(countries.length
        ? [
            prisma.adminCountryAccess.createMany({
              data: countries.map((country) => ({ adminId, country, createdByAdminId })),
            }),
          ]
        : []),
    ])
  },

  async hasAnyGrant(adminId: string): Promise<boolean> {
    const count = await prismaRead.adminCountryAccess.count({ where: { adminId } })
    return count > 0
  },
}
