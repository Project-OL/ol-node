import type { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

/**
 * Minimal, non-sensitive field set for the country-scoped search page — no
 * email/phone/other PII. Mirrors the shape of `adminUserSearchSelect`
 * (`adminUserSearch.repository.ts`) but deliberately trimmed down.
 */
export const adminCountryUserSearchSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  country: true,
} satisfies Prisma.UserSelect

export type AdminCountryUserSearchRow = Prisma.UserGetPayload<{
  select: typeof adminCountryUserSearchSelect
}>

export const adminCountryUserSearchRepository = {
  /**
   * Same name-match OR-clause as `adminUserSearch.repository.ts#searchByName`,
   * narrowed to the caller's granted countries. Empty `q` returns the most
   * recently created users in-scope (browse mode).
   */
  async search(
    countries: string[],
    query: string,
    limit: number,
  ): Promise<AdminCountryUserSearchRow[]> {
    const q = query.trim()
    const countryFilter: Prisma.UserWhereInput = { country: { in: countries } }

    if (!q) {
      return prismaRead.user.findMany({
        where: countryFilter,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: adminCountryUserSearchSelect,
      })
    }

    const or: Prisma.UserWhereInput[] = [
      { username: { contains: q, mode: 'insensitive' } },
      { firstName: { contains: q, mode: 'insensitive' } },
      { lastName: { contains: q, mode: 'insensitive' } },
    ]
    const spaceIdx = q.indexOf(' ')
    if (spaceIdx > 0) {
      const first = q.slice(0, spaceIdx).trim()
      const last = q.slice(spaceIdx + 1).trim()
      if (first.length > 0 && last.length > 0) {
        or.push({
          AND: [
            { firstName: { contains: first, mode: 'insensitive' } },
            { lastName: { contains: last, mode: 'insensitive' } },
          ],
        })
      }
    }

    return prismaRead.user.findMany({
      where: { AND: [countryFilter, { OR: or }] },
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: adminCountryUserSearchSelect,
    })
  },
}
