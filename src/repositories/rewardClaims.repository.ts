import { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'
import { countryEqualsFilter } from '../utils/agency-country'

export type RewardClaimType = 'NORMAL_HOST' | 'ROYAL_HOST' | 'LIVESTREAM_STREAK'

export type RewardClaimUserTotalRow = {
  userId: string
  username: string
  country: string | null
  publicId: bigint
  totalPoints: bigint
  claimCount: bigint
}

export type RewardClaimRow = {
  userId: string
  type: RewardClaimType
  claimDate: Date
  pointsAmount: bigint
  ledgerEntryId: string
  claimedAt: Date
}

/** One `UNION ALL` over the three reward-claim tables, each already shaped user_id/type/date/points/ledger_entry_id/claimed_at. */
function claimsCte(params: { from?: Date; to?: Date; type?: RewardClaimType }) {
  const fromClause = params.from ? Prisma.sql`AND claim_date >= ${params.from}` : Prisma.empty
  const toClause = params.to ? Prisma.sql`AND claim_date <= ${params.to}` : Prisma.empty

  const sources: { type: RewardClaimType; sql: Prisma.Sql }[] = [
    {
      type: 'NORMAL_HOST',
      sql: Prisma.sql`SELECT user_id, 'NORMAL_HOST'::text AS type, reward_date AS claim_date, points_amount, ledger_entry_id, claimed_at FROM normal_host_reward_claims`,
    },
    {
      type: 'ROYAL_HOST',
      sql: Prisma.sql`SELECT user_id, 'ROYAL_HOST'::text AS type, week_start AS claim_date, points_amount, ledger_entry_id, claimed_at FROM royal_host_reward_claims`,
    },
    {
      type: 'LIVESTREAM_STREAK',
      sql: Prisma.sql`SELECT user_id, 'LIVESTREAM_STREAK'::text AS type, claim_date, points_amount, ledger_entry_id, claimed_at FROM livestream_reward_claims`,
    },
  ]
  const parts = sources.filter((s) => !params.type || s.type === params.type).map((s) => s.sql)

  const union = Prisma.join(parts, ' UNION ALL ')
  return Prisma.sql`
    WITH claims AS (${union})
    SELECT * FROM claims WHERE true ${fromClause} ${toClause}
  `
}

export const rewardClaimsRepository = {
  /** Per-user totals across all reward claim types, sorted by total desc, paginated. */
  async listUsersByTotalClaimed(params: {
    country?: string
    from?: Date
    to?: Date
    type?: RewardClaimType
    skip: number
    take: number
  }): Promise<{ items: RewardClaimUserTotalRow[]; total: number }> {
    const cte = claimsCte(params)
    const countryClause = params.country
      ? Prisma.sql`AND u.country = ${countryEqualsFilter(params.country).equals}`
      : Prisma.empty

    const rows = await prismaRead.$queryRaw<
      {
        user_id: string
        username: string
        country: string | null
        public_id: bigint
        total_points: bigint
        claim_count: bigint
      }[]
    >(Prisma.sql`
      SELECT c.user_id, u.username, u.country, u.public_id,
        SUM(c.points_amount)::bigint AS total_points,
        COUNT(*)::bigint AS claim_count
      FROM (${cte}) c
      INNER JOIN users u ON u.id = c.user_id
      WHERE true ${countryClause}
      GROUP BY c.user_id, u.username, u.country, u.public_id
      ORDER BY total_points DESC
      LIMIT ${params.take} OFFSET ${params.skip}
    `)

    const totalRows = await prismaRead.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT c.user_id)::bigint AS count
      FROM (${cte}) c
      INNER JOIN users u ON u.id = c.user_id
      WHERE true ${countryClause}
    `)

    return {
      items: rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        country: r.country,
        publicId: r.public_id,
        totalPoints: r.total_points,
        claimCount: r.claim_count,
      })),
      total: Number(totalRows[0]?.count ?? 0n),
    }
  },

  /** Individual claim rows for a set of users (same date/type filter as the totals query). */
  async listClaimsForUsers(params: {
    userIds: string[]
    from?: Date
    to?: Date
    type?: RewardClaimType
  }): Promise<RewardClaimRow[]> {
    if (params.userIds.length === 0) return []
    const cte = claimsCte(params)
    const rows = await prismaRead.$queryRaw<
      {
        user_id: string
        type: RewardClaimType
        claim_date: Date
        points_amount: bigint
        ledger_entry_id: string
        claimed_at: Date
      }[]
    >(Prisma.sql`
      SELECT * FROM (${cte}) c
      WHERE c.user_id IN (${Prisma.join(params.userIds.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY c.claimed_at DESC
    `)

    return rows.map((r) => ({
      userId: r.user_id,
      type: r.type,
      claimDate: r.claim_date,
      pointsAmount: r.points_amount,
      ledgerEntryId: r.ledger_entry_id,
      claimedAt: r.claimed_at,
    }))
  },

  /** Every claim row matching the filter, unpaginated — for Excel export (caller enforces a row cap). */
  async listAllClaims(params: {
    country?: string
    from?: Date
    to?: Date
    type?: RewardClaimType
  }): Promise<(RewardClaimRow & { username: string; country: string | null; publicId: bigint })[]> {
    const cte = claimsCte(params)
    const countryClause = params.country
      ? Prisma.sql`AND u.country = ${countryEqualsFilter(params.country).equals}`
      : Prisma.empty

    const rows = await prismaRead.$queryRaw<
      {
        user_id: string
        type: RewardClaimType
        claim_date: Date
        points_amount: bigint
        ledger_entry_id: string
        claimed_at: Date
        username: string
        country: string | null
        public_id: bigint
      }[]
    >(Prisma.sql`
      SELECT c.*, u.username, u.country, u.public_id
      FROM (${cte}) c
      INNER JOIN users u ON u.id = c.user_id
      WHERE true ${countryClause}
      ORDER BY c.claimed_at DESC
    `)

    return rows.map((r) => ({
      userId: r.user_id,
      type: r.type,
      claimDate: r.claim_date,
      pointsAmount: r.points_amount,
      ledgerEntryId: r.ledger_entry_id,
      claimedAt: r.claimed_at,
      username: r.username,
      country: r.country,
      publicId: r.public_id,
    }))
  },

  /** Batch "already reverted" check by ledger entry id (mirrors admin-transactions.repository's single-entry lookup). */
  async findReversedLedgerEntryIds(ledgerEntryIds: string[]): Promise<Set<string>> {
    if (ledgerEntryIds.length === 0) return new Set()
    const keys = ledgerEntryIds.map((id) => `admin-revert:point-single:${id}:reverse`)
    const rows = await prismaRead.pointLedgerEntry.findMany({
      where: { idempotencyKey: { in: keys } },
      select: { idempotencyKey: true },
    })
    return new Set(
      rows.map((r) =>
        r.idempotencyKey!.replace(/^admin-revert:point-single:/, '').replace(/:reverse$/, ''),
      ),
    )
  },
}
