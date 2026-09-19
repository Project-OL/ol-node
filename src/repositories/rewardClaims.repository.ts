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
  totalDeducted: bigint
  deductionCount: bigint
}

export type RewardClaimRow = {
  userId: string
  type: RewardClaimType
  claimDate: Date
  pointsAmount: bigint
  ledgerEntryId: string
  claimedAt: Date
}

export type AdminDeductionRow = {
  userId: string
  ledgerEntryId: string
  amount: bigint
  description: string | null
  adminUserId: string | null
  createdAt: Date
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

/**
 * Admin-initiated point debits: `POST /admin/users/:userId/wallet/points/deduct` and the
 * bulk-deduct variant (`adminWalletService.debitPoints`), tagged `metadata.source =
 * 'admin_wallet_debit'`. Deliberately excludes debits from reverting a reward claim
 * (`admin_single_wallet_revert` / `admin_transaction_revert`) — those are shown via the
 * claim's own `reverted` flag, not as a fresh deduction. Date filter applies to the debit's
 * own `created_at` (deductions have no separate "claim date").
 */
function deductionsCte(params: { from?: Date; to?: Date }) {
  const fromClause = params.from ? Prisma.sql`AND ple.created_at >= ${params.from}` : Prisma.empty
  const toClause = params.to ? Prisma.sql`AND ple.created_at <= ${params.to}` : Prisma.empty
  return Prisma.sql`
    SELECT w.user_id, ple.id AS ledger_entry_id, ple.amount, ple.description,
      ple.created_at, ple.metadata->>'adminUserId' AS admin_user_id
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id AND w.currency_type = 'POINT'
    WHERE ple.direction = 'DEBIT'
      AND ple.tx_type = 'ADJUSTMENT'
      AND ple.metadata->>'source' = 'admin_wallet_debit'
      ${fromClause} ${toClause}
  `
}

export const rewardClaimsRepository = {
  /**
   * Per-user totals, sorted by total claimed desc, paginated. Rows are the union of users
   * with a reward claim and users with an admin point deduction (`deductionsCte`) — a user
   * who was only ever debited by an admin (no claims) still appears, with `totalPoints: 0`.
   * `type` only narrows the claims side; deduction totals are always all-time/all-source.
   */
  async listUsersByTotalClaimed(params: {
    country?: string
    agencyUserId?: string
    from?: Date
    to?: Date
    type?: RewardClaimType
    skip: number
    take: number
  }): Promise<{ items: RewardClaimUserTotalRow[]; total: number }> {
    const cte = claimsCte(params)
    const dCte = deductionsCte(params)
    const countryClause = params.country
      ? Prisma.sql`AND u.country = ${countryEqualsFilter(params.country).equals}`
      : Prisma.empty
    const agencyClause = params.agencyUserId
      ? Prisma.sql`AND u.current_agency_id = ${params.agencyUserId}::uuid`
      : Prisma.empty

    const rows = await prismaRead.$queryRaw<
      {
        user_id: string
        username: string
        country: string | null
        public_id: bigint
        total_points: bigint
        claim_count: bigint
        total_deducted: bigint
        deduction_count: bigint
      }[]
    >(Prisma.sql`
      WITH claim_totals AS (
        SELECT c.user_id, SUM(c.points_amount)::bigint AS total_points, COUNT(*)::bigint AS claim_count
        FROM (${cte}) c
        GROUP BY c.user_id
      ), deduction_totals AS (
        SELECT d.user_id, SUM(d.amount)::bigint AS total_deducted, COUNT(*)::bigint AS deduction_count
        FROM (${dCte}) d
        GROUP BY d.user_id
      )
      SELECT
        COALESCE(ct.user_id, dt.user_id) AS user_id,
        u.username, u.country, u.public_id,
        COALESCE(ct.total_points, 0)::bigint AS total_points,
        COALESCE(ct.claim_count, 0)::bigint AS claim_count,
        COALESCE(dt.total_deducted, 0)::bigint AS total_deducted,
        COALESCE(dt.deduction_count, 0)::bigint AS deduction_count
      FROM claim_totals ct
      FULL OUTER JOIN deduction_totals dt ON dt.user_id = ct.user_id
      INNER JOIN users u ON u.id = COALESCE(ct.user_id, dt.user_id)
      WHERE true ${countryClause} ${agencyClause}
      ORDER BY total_points DESC, total_deducted DESC
      LIMIT ${params.take} OFFSET ${params.skip}
    `)

    const totalRows = await prismaRead.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      WITH claim_totals AS (
        SELECT DISTINCT c.user_id FROM (${cte}) c
      ), deduction_totals AS (
        SELECT DISTINCT d.user_id FROM (${dCte}) d
      )
      SELECT COUNT(*)::bigint AS count
      FROM claim_totals ct
      FULL OUTER JOIN deduction_totals dt ON dt.user_id = ct.user_id
      INNER JOIN users u ON u.id = COALESCE(ct.user_id, dt.user_id)
      WHERE true ${countryClause} ${agencyClause}
    `)

    return {
      items: rows.map((r) => ({
        userId: r.user_id,
        username: r.username,
        country: r.country,
        publicId: r.public_id,
        totalPoints: r.total_points,
        claimCount: r.claim_count,
        totalDeducted: r.total_deducted,
        deductionCount: r.deduction_count,
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

  /** Individual admin-deduction rows for a set of users (same date filter as the totals query). */
  async listDeductionsForUsers(params: {
    userIds: string[]
    from?: Date
    to?: Date
  }): Promise<AdminDeductionRow[]> {
    if (params.userIds.length === 0) return []
    const cte = deductionsCte(params)
    const rows = await prismaRead.$queryRaw<
      {
        user_id: string
        ledger_entry_id: string
        amount: bigint
        description: string | null
        created_at: Date
        admin_user_id: string | null
      }[]
    >(Prisma.sql`
      SELECT * FROM (${cte}) d
      WHERE d.user_id IN (${Prisma.join(params.userIds.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY d.created_at DESC
    `)

    return rows.map((r) => ({
      userId: r.user_id,
      ledgerEntryId: r.ledger_entry_id,
      amount: r.amount,
      description: r.description,
      adminUserId: r.admin_user_id,
      createdAt: r.created_at,
    }))
  },

  /** Every admin-deduction row matching the filter, unpaginated — for Excel export. */
  async listAllDeductions(params: {
    country?: string
    agencyUserId?: string
    from?: Date
    to?: Date
  }): Promise<
    (AdminDeductionRow & { username: string; country: string | null; publicId: bigint })[]
  > {
    const cte = deductionsCte(params)
    const countryClause = params.country
      ? Prisma.sql`AND u.country = ${countryEqualsFilter(params.country).equals}`
      : Prisma.empty
    const agencyClause = params.agencyUserId
      ? Prisma.sql`AND u.current_agency_id = ${params.agencyUserId}::uuid`
      : Prisma.empty

    const rows = await prismaRead.$queryRaw<
      {
        user_id: string
        ledger_entry_id: string
        amount: bigint
        description: string | null
        created_at: Date
        admin_user_id: string | null
        username: string
        country: string | null
        public_id: bigint
      }[]
    >(Prisma.sql`
      SELECT d.*, u.username, u.country, u.public_id
      FROM (${cte}) d
      INNER JOIN users u ON u.id = d.user_id
      WHERE true ${countryClause} ${agencyClause}
      ORDER BY d.created_at DESC
    `)

    return rows.map((r) => ({
      userId: r.user_id,
      ledgerEntryId: r.ledger_entry_id,
      amount: r.amount,
      description: r.description,
      adminUserId: r.admin_user_id,
      createdAt: r.created_at,
      username: r.username,
      country: r.country,
      publicId: r.public_id,
    }))
  },

  /** Every claim row matching the filter, unpaginated — for Excel export (caller enforces a row cap). */
  async listAllClaims(params: {
    country?: string
    agencyUserId?: string
    from?: Date
    to?: Date
    type?: RewardClaimType
  }): Promise<(RewardClaimRow & { username: string; country: string | null; publicId: bigint })[]> {
    const cte = claimsCte(params)
    const countryClause = params.country
      ? Prisma.sql`AND u.country = ${countryEqualsFilter(params.country).equals}`
      : Prisma.empty
    const agencyClause = params.agencyUserId
      ? Prisma.sql`AND u.current_agency_id = ${params.agencyUserId}::uuid`
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
      WHERE true ${countryClause} ${agencyClause}
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
