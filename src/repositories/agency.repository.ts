import type { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type AgencyAdminListParams = {
  status?: 'ACTIVE' | 'SUSPENDED'
  country?: string
  search?: string
  skip: number
  take: number
}

function buildAdminListWhere(params: AgencyAdminListParams): Prisma.AgencyWhereInput {
  const now = new Date()
  const and: Prisma.AgencyWhereInput[] = []

  if (params.status === 'ACTIVE') {
    and.push({
      OR: [{ pausedAt: null }, { pausedUntil: { lte: now } }],
    })
  } else if (params.status === 'SUSPENDED') {
    and.push({
      pausedAt: { not: null },
      OR: [{ pausedUntil: null }, { pausedUntil: { gt: now } }],
    })
  }

  if (params.country) {
    and.push({ user: { country: params.country } })
  }

  const q = params.search?.trim()
  if (q) {
    let publicIdFilter: bigint | null = null
    try {
      publicIdFilter = BigInt(q)
    } catch {
      /* not numeric */
    }
    const or: Prisma.AgencyWhereInput[] = [
      { displayName: { contains: q, mode: 'insensitive' } },
      { user: { username: { contains: q, mode: 'insensitive' } } },
    ]
    if (publicIdFilter != null) {
      or.push(
        { defaultPublicId: publicIdFilter },
        { user: { defaultPublicId: publicIdFilter } },
        { user: { publicId: publicIdFilter } },
        { user: { currentVipPublicId: publicIdFilter } },
      )
    }
    and.push({ OR: or })
  }

  return and.length > 0 ? { AND: and } : {}
}

export const agencyRepository = {
  async createAgency(
    data: { userId: string; defaultPublicId: bigint; displayName: string },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agency.create({
      data: {
        userId: data.userId,
        defaultPublicId: data.defaultPublicId,
        displayName: data.displayName,
      },
    })
  },

  async getAgencyByUserId(userId: string) {
    return prismaRead.agency.findUnique({
      where: { userId },
    })
  },

  /**
   * Resolve an agency by any externally visible numeric id:
   * - `agencies.default_public_id` (canonical agency id)
   * - agency owner's `public_id`, `default_public_id`, or `current_vip_public_id`
   */
  async getAgencyByPublicId(publicId: bigint) {
    const byDefault = await prismaRead.agency.findUnique({
      where: { defaultPublicId: publicId },
    })
    if (byDefault) return byDefault

    const owner = await prismaRead.user.findFirst({
      where: {
        isAgent: true,
        OR: [{ publicId }, { defaultPublicId: publicId }, { currentVipPublicId: publicId }],
      },
      select: { id: true },
    })
    if (!owner) return null

    return prismaRead.agency.findUnique({
      where: { userId: owner.id },
    })
  },

  async setPause(
    userId: string,
    data: { pausedAt: Date | null; pausedUntil: Date | null },
    tx: Prisma.TransactionClient,
  ) {
    return tx.agency.update({
      where: { userId },
      data: {
        pausedAt: data.pausedAt,
        pausedUntil: data.pausedUntil,
      },
    })
  },

  async setPayrollEnabled(userId: string, payrollEnabled: boolean, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    if (payrollEnabled) {
      const cur = await client.agency.findUnique({
        where: { userId },
        select: { payrollEnabledAt: true },
      })
      return client.agency.update({
        where: { userId },
        data: {
          payrollEnabled: true,
          // Jump to front of LRA queue when accepting payroll (NULLS FIRST).
          lastPayrollAssignedAt: null,
          // Keep first-enable time for seniority; set only once.
          ...(cur?.payrollEnabledAt ? {} : { payrollEnabledAt: new Date() }),
        },
      })
    }
    return client.agency.update({
      where: { userId },
      data: { payrollEnabled: false },
    })
  },

  /**
   * Admin grant/revoke payroll privilege.
   * Revoke always forces agent accept-toggle off.
   */
  async setPayrollPrivilegeGranted(
    userId: string,
    payrollPrivilegeGranted: boolean,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma
    return client.agency.update({
      where: { userId },
      data: payrollPrivilegeGranted
        ? { payrollPrivilegeGranted: true }
        : {
            payrollPrivilegeGranted: false,
            payrollEnabled: false,
          },
    })
  },

  async incrementHostCount(userId: string, delta: number, tx: Prisma.TransactionClient) {
    return tx.agency.update({
      where: { userId },
      data: {
        totalHostsCount: { increment: delta },
      },
    })
  },

  async updateDisplayAndLevels(
    userId: string,
    data: {
      displayName?: string
      currentLevel?: string
      lifetimeHostEarningsPoints?: bigint
      currentWindowTotalPoints?: bigint
      lastLevelRecomputedAt?: Date | null
    },
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? prisma
    return client.agency.update({
      where: { userId },
      data,
    })
  },

  /**
   * Phase 1: sort by totalHostsCount desc, tie-break defaultPublicId desc.
   * Cursor: opaque offset string (see agencyRanking.service).
   */
  async countAll() {
    return prismaRead.agency.count()
  },

  async countActive() {
    const now = new Date()
    return prismaRead.agency.count({
      where: {
        OR: [{ pausedAt: null }, { pausedUntil: { lte: now } }],
      },
    })
  },

  async countSuspended() {
    const now = new Date()
    return prismaRead.agency.count({
      where: {
        pausedAt: { not: null },
        OR: [{ pausedUntil: null }, { pausedUntil: { gt: now } }],
      },
    })
  },

  async countAllHosts() {
    return prismaRead.agencyHost.count()
  },

  async sumPlatformDailyEarnings(fromDay: Date, toDay: Date): Promise<bigint> {
    const rows = await prismaRead.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(SUM(e.host_earnings_points + e.host_commission_points), 0)::bigint AS s
      FROM agency_daily_earnings e
      INNER JOIN users u ON u.id = e.host_user_id
      WHERE e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND u.status NOT IN ('suspended', 'deleted')
    `
    return rows[0]?.s ?? 0n
  },

  async listForAdmin(params: AgencyAdminListParams) {
    return prismaRead.agency.findMany({
      where: buildAdminListWhere(params),
      orderBy: [{ totalHostsCount: 'desc' }, { defaultPublicId: 'desc' }],
      skip: params.skip,
      take: params.take,
      select: {
        userId: true,
        defaultPublicId: true,
        totalHostsCount: true,
        currentLevel: true,
        payrollEnabled: true,
        payrollPrivilegeGranted: true,
        pausedAt: true,
        pausedUntil: true,
        createdAt: true,
        user: {
          select: {
            username: true,
            firstName: true,
            lastName: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            country: true,
          },
        },
      },
    })
  },

  async countForAdmin(params: Omit<AgencyAdminListParams, 'skip' | 'take'>) {
    return prismaRead.agency.count({
      where: buildAdminListWhere({ ...params, skip: 0, take: 1 }),
    })
  },

  async sumEarningsByAgencyForRange(fromDay: Date, toDay: Date): Promise<Map<string, bigint>> {
    const rows = await prismaRead.$queryRaw<{ agency_user_id: string; s: bigint }[]>`
      SELECT
        e.agency_user_id,
        COALESCE(SUM(e.host_earnings_points + e.host_commission_points), 0)::bigint AS s
      FROM agency_daily_earnings e
      INNER JOIN users u ON u.id = e.host_user_id
      WHERE e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND u.status NOT IN ('suspended', 'deleted')
      GROUP BY e.agency_user_id
    `
    return new Map(rows.map((r) => [r.agency_user_id, r.s]))
  },

  async countHostsWithCommission(agencyUserId: string): Promise<number> {
    const rows = await prismaRead.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(DISTINCT e.host_user_id)::bigint AS c
      FROM agency_daily_earnings e
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND e.host_commission_points > 0
    `
    return Number(rows[0]?.c ?? 0n)
  },

  async setCommissionLevel(userId: string, level: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? prisma
    return client.agency.update({
      where: { userId },
      data: { currentLevel: level },
    })
  },

  async listForRanking(params: { limit: number; skip: number; country: string | null }) {
    if (!params.country) return []
    return prismaRead.agency.findMany({
      where: {
        user: { country: params.country },
      },
      orderBy: [{ totalHostsCount: 'desc' }, { defaultPublicId: 'desc' }],
      skip: params.skip,
      take: params.limit + 1,
      select: {
        userId: true,
        defaultPublicId: true,
        displayName: true,
        totalHostsCount: true,
        lifetimeHostEarningsPoints: true,
        currentLevel: true,
        pausedAt: true,
        pausedUntil: true,
      },
    })
  },
}
