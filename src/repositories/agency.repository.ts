import type { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { countryEqualsFilter } from '../utils/agency-country'

export type AgencyAdminListParams = {
  status?: 'ACTIVE' | 'SUSPENDED'
  country?: string
  search?: string
  /** When true, only agencies whose owner TRADING_COIN balance meets the coinseller threshold. */
  coinseller?: boolean
  /** Precomputed owner ids when `coinseller` filter is applied (set by service). */
  coinsellerAgencyUserIds?: string[]
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
    and.push({ user: { country: countryEqualsFilter(params.country) } })
  }

  if (params.coinsellerAgencyUserIds) {
    and.push({ userId: { in: params.coinsellerAgencyUserIds } })
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
        user: { country: countryEqualsFilter(params.country) },
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

  /**
   * Agencies whose owner TRADING_COIN balance is at/above `minTradingBalance`.
   * Same sort/cursor model as {@link listForRanking}; country-scoped when provided.
   */
  async listForCoinsellerListing(params: {
    limit: number
    skip: number
    country: string | null
    minTradingBalance: bigint
  }) {
    if (!params.country) return []
    const country = params.country.trim()
    const rows = await prismaRead.$queryRaw<
      Array<{
        user_id: string
        default_public_id: bigint
        display_name: string
        total_hosts_count: number
        lifetime_host_earnings_points: bigint
        current_level: string
        paused_at: Date | null
        paused_until: Date | null
      }>
    >`
      SELECT
        a.user_id,
        a.default_public_id,
        a.display_name,
        a.total_hosts_count,
        a.lifetime_host_earnings_points,
        a.current_level,
        a.paused_at,
        a.paused_until
      FROM agencies a
      INNER JOIN users u ON u.id = a.user_id
      INNER JOIN wallets w
        ON w.user_id = a.user_id
       AND w.currency_type = 'TRADING_COIN'
      INNER JOIN LATERAL (
        SELECT cle.balance_after
        FROM coin_ledger_entries cle
        WHERE cle.wallet_id = w.id
        ORDER BY cle.created_at DESC, cle.id DESC
        LIMIT 1
      ) bal ON true
      WHERE LOWER(TRIM(u.country)) = LOWER(TRIM(${country}))
        AND bal.balance_after >= ${params.minTradingBalance}
      ORDER BY a.total_hosts_count DESC, a.default_public_id DESC
      OFFSET ${params.skip}
      LIMIT ${params.limit + 1}
    `
    return rows.map((r) => ({
      userId: r.user_id,
      defaultPublicId: r.default_public_id,
      displayName: r.display_name,
      totalHostsCount: r.total_hosts_count,
      lifetimeHostEarningsPoints: r.lifetime_host_earnings_points,
      currentLevel: r.current_level,
      pausedAt: r.paused_at,
      pausedUntil: r.paused_until,
    }))
  },

  /** Agency owner user ids with TRADING_COIN balance >= min (for admin list filter). */
  async listCoinsellerAgencyUserIds(minTradingBalance: bigint): Promise<string[]> {
    const rows = await prismaRead.$queryRaw<Array<{ user_id: string }>>`
      SELECT a.user_id
      FROM agencies a
      INNER JOIN wallets w
        ON w.user_id = a.user_id
       AND w.currency_type = 'TRADING_COIN'
      INNER JOIN LATERAL (
        SELECT cle.balance_after
        FROM coin_ledger_entries cle
        WHERE cle.wallet_id = w.id
        ORDER BY cle.created_at DESC, cle.id DESC
        LIMIT 1
      ) bal ON true
      WHERE bal.balance_after >= ${minTradingBalance}
    `
    return rows.map((r) => r.user_id)
  },
}
