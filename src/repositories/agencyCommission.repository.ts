import { LedgerDirection, PointTxType, Prisma, WalletCurrencyType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

export type AgencyCommissionLevelRow = {
  level: string
  minWindowPoints: bigint
  liveRateBp: number
  matchChatRateBp: number
  sortOrder: number
}

export const agencyCommissionRepository = {
  async getLevelConfig(): Promise<AgencyCommissionLevelRow[]> {
    const rows = await prismaRead.agencyCommissionLevel.findMany({
      orderBy: { sortOrder: 'asc' },
    })
    return rows.map((r) => ({
      level: r.level,
      minWindowPoints: r.minWindowPoints,
      liveRateBp: r.liveRateBp,
      matchChatRateBp: r.matchChatRateBp,
      sortOrder: r.sortOrder,
    }))
  },

  async getLevelRow(level: string): Promise<AgencyCommissionLevelRow | null> {
    const r = await prismaRead.agencyCommissionLevel.findUnique({
      where: { level },
    })
    if (!r) return null
    return {
      level: r.level,
      minWindowPoints: r.minWindowPoints,
      liveRateBp: r.liveRateBp,
      matchChatRateBp: r.matchChatRateBp,
      sortOrder: r.sortOrder,
    }
  },

  /**
   * AGENT_COMMISSION ledger rows on the agency POINT wallet (newest first).
   * Optional `hostUserId` filters by counterparty (the host who generated the commission).
   */
  async listCommissionHistory(params: {
    agencyUserId: string
    hostUserId?: string
    /** Inclusive lower bound (UTC). */
    from?: Date
    /** Exclusive upper bound (UTC); typically next midnight after inclusive `to` day. */
    toExclusive?: Date
    cursor?: string
    limit: number
  }): Promise<
    Array<{
      id: string
      amount: bigint
      balanceAfter: bigint
      direction: LedgerDirection
      refId: string | null
      counterpartyId: string | null
      description: string | null
      metadata: unknown
      createdAt: Date
    }>
  > {
    const wallet = await prismaRead.wallet.findUnique({
      where: {
        userId_currencyType: {
          userId: params.agencyUserId,
          currencyType: WalletCurrencyType.POINT,
        },
      },
      select: { id: true },
    })
    if (!wallet) return []

    let cursorCreatedAt: Date | undefined
    if (params.cursor) {
      const cur = await prismaRead.pointLedgerEntry.findUnique({
        where: { id: params.cursor },
        select: { createdAt: true },
      })
      cursorCreatedAt = cur?.createdAt
    }

    const createdAt: Prisma.DateTimeFilter = {}
    if (params.from) createdAt.gte = params.from
    // Cursor pages older than the previous page; combine with toExclusive via AND of lt bounds.
    const upperExclusive =
      cursorCreatedAt && params.toExclusive
        ? cursorCreatedAt < params.toExclusive
          ? cursorCreatedAt
          : params.toExclusive
        : (cursorCreatedAt ?? params.toExclusive)
    if (upperExclusive) createdAt.lt = upperExclusive

    return prismaRead.pointLedgerEntry.findMany({
      where: {
        walletId: wallet.id,
        txType: PointTxType.AGENT_COMMISSION,
        ...(params.hostUserId ? { counterpartyId: params.hostUserId } : {}),
        ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit + 1,
      select: {
        id: true,
        amount: true,
        balanceAfter: true,
        direction: true,
        refId: true,
        counterpartyId: true,
        description: true,
        metadata: true,
        createdAt: true,
      },
    })
  },

  async upsertDailyEarning(
    {
      agencyUserId,
      hostUserId,
      day,
      hostEarningsDelta,
      hostCommissionDelta,
    }: {
      agencyUserId: string
      hostUserId: string
      day: Date
      hostEarningsDelta: bigint
      hostCommissionDelta: bigint
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO agency_daily_earnings (
        agency_user_id, host_user_id, day,
        host_earnings_points, host_commission_points, host_was_active, last_credit_at
      )
      VALUES (
        ${agencyUserId}::uuid,
        ${hostUserId}::uuid,
        ${day}::date,
        GREATEST(0, ${hostEarningsDelta}),
        GREATEST(0, ${hostCommissionDelta}),
        true,
        NOW()
      )
      ON CONFLICT (agency_user_id, host_user_id, day) DO UPDATE SET
        host_earnings_points = GREATEST(
          0,
          agency_daily_earnings.host_earnings_points + ${hostEarningsDelta}
        ),
        host_commission_points = GREATEST(
          0,
          agency_daily_earnings.host_commission_points + ${hostCommissionDelta}
        ),
        host_was_active = true,
        last_credit_at = NOW()
    `
  },

  /**
   * Rolling-window total used for agency commission tier matching / progress.
   * Sums unreversed AGENT_COMMISSION ledger credits whose `created_at` falls in
   * the half-open window `[from, toExclusive)`. Host earnings are excluded.
   * Credits reversed via admin clawback (`agency-commission-reverse:*`) are omitted.
   */
  async getAgencyWindowTotal(
    agencyUserId: string,
    from: Date,
    toExclusive: Date,
    opts?: { preferPrimary?: boolean },
  ): Promise<bigint> {
    const client = opts?.preferPrimary ? prisma : prismaRead
    const rows = await client.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(SUM(ple.amount), 0)::bigint AS s
      FROM point_ledger_entries ple
      INNER JOIN wallets w
        ON w.id = ple.wallet_id
       AND w.user_id = ${agencyUserId}::uuid
       AND w.currency_type = 'POINT'
      LEFT JOIN users u ON u.id = ple.counterparty_id
      WHERE ple.tx_type = 'AGENT_COMMISSION'
        AND ple.direction = 'CREDIT'
        AND ple.created_at >= ${from}
        AND ple.created_at < ${toExclusive}
        AND (u.id IS NULL OR u.status NOT IN ('suspended', 'deleted'))
        AND NOT EXISTS (
          SELECT 1
          FROM point_ledger_entries rev
          WHERE rev.idempotency_key =
            'agency-commission-reverse:' ||
            COALESCE(
              NULLIF(ple.metadata->>'hostLedgerEntryId', ''),
              CASE
                WHEN ple.idempotency_key LIKE 'agency-commission:%'
                THEN substring(ple.idempotency_key FROM length('agency-commission:') + 1)
                ELSE NULL
              END
            )
        )
    `
    return rows[0]?.s ?? 0n
  },

  /** Cursor page of all agency owner ids (for nightly window-slide recompute). */
  async listAllAgencyUserIds(opts: { cursor: string | null; limit: number }): Promise<string[]> {
    const cur = opts.cursor && opts.cursor.length > 0 ? opts.cursor : ZERO_UUID
    const rows = await prismaRead.$queryRaw<{ user_id: string }[]>`
      SELECT a.user_id
      FROM agencies a
      WHERE a.user_id > ${cur}::uuid
      ORDER BY a.user_id ASC
      LIMIT ${opts.limit}
    `
    return rows.map((r) => r.user_id)
  },

  async listAgenciesForRecompute({
    fromDay,
    toDay,
    cursor,
    limit,
  }: {
    fromDay: Date
    toDay: Date
    cursor: string | null
    limit: number
  }): Promise<string[]> {
    const cur = cursor && cursor.length > 0 ? cursor : ZERO_UUID
    const rows = await prismaRead.$queryRaw<{ agency_user_id: string }[]>`
      SELECT DISTINCT e.agency_user_id
      FROM agency_daily_earnings e
      WHERE e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND e.agency_user_id > ${cur}::uuid
      ORDER BY e.agency_user_id ASC
      LIMIT ${limit}
    `
    return rows.map((r) => r.agency_user_id)
  },

  /** Per-host totals from daily earnings (commission panel). */
  async sumHostEarningsByHost(
    agencyUserId: string,
    fromDay: Date,
    toDay: Date,
    opts?: { limit: number; offset: number },
  ): Promise<
    Array<{
      hostUserId: string
      hostEarningsPoints: bigint
      hostCommissionPoints: bigint
      liveDurationSeconds: bigint
    }>
  > {
    const limit = opts?.limit ?? 50
    const offset = opts?.offset ?? 0
    const rows = await prismaRead.$queryRaw<
      {
        host_user_id: string
        earnings: bigint
        commission: bigint
        live_duration: bigint
      }[]
    >`
      SELECT * FROM (
        SELECT
          e.host_user_id,
          COALESCE(SUM(e.host_earnings_points), 0)::bigint AS earnings,
          COALESCE(SUM(e.host_commission_points), 0)::bigint AS commission,
          COALESCE(SUM(e.live_duration_seconds), 0)::bigint AS live_duration
        FROM agency_daily_earnings e
        INNER JOIN users u ON u.id = e.host_user_id
        WHERE e.agency_user_id = ${agencyUserId}::uuid
          AND e.day >= ${fromDay}::date
          AND e.day <= ${toDay}::date
          AND e.host_was_active = true
          AND u.status NOT IN ('suspended', 'deleted')
        GROUP BY e.host_user_id
      ) t
      ORDER BY t.earnings DESC, t.host_user_id ASC
      LIMIT ${limit + 1}
      OFFSET ${offset}
    `
    return rows.map((r) => ({
      hostUserId: r.host_user_id,
      hostEarningsPoints: r.earnings,
      hostCommissionPoints: r.commission,
      liveDurationSeconds: r.live_duration,
    }))
  },

  /** All-time agency daily earnings totals (host earnings + commission). */
  async sumAgencyDailyEarningsAllTime(agencyUserId: string): Promise<{
    hostEarningsPoints: bigint
    hostCommissionPoints: bigint
  }> {
    const rows = await prismaRead.$queryRaw<{ earnings: bigint; commission: bigint }[]>`
      SELECT
        COALESCE(SUM(e.host_earnings_points), 0)::bigint AS earnings,
        COALESCE(SUM(e.host_commission_points), 0)::bigint AS commission
      FROM agency_daily_earnings e
      INNER JOIN users u ON u.id = e.host_user_id
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND u.status NOT IN ('suspended', 'deleted')
    `
    return {
      hostEarningsPoints: rows[0]?.earnings ?? 0n,
      hostCommissionPoints: rows[0]?.commission ?? 0n,
    }
  },

  /** Agency-wide host earnings + commission sums from the daily table for a day range. */
  async sumAgencyDailyEarnings(
    agencyUserId: string,
    fromDay: Date,
    toDay: Date,
  ): Promise<{ hostEarningsPoints: bigint; hostCommissionPoints: bigint }> {
    const rows = await prismaRead.$queryRaw<{ earnings: bigint; commission: bigint }[]>`
      SELECT
        COALESCE(SUM(e.host_earnings_points), 0)::bigint AS earnings,
        COALESCE(SUM(e.host_commission_points), 0)::bigint AS commission
      FROM agency_daily_earnings e
      INNER JOIN users u ON u.id = e.host_user_id
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND u.status NOT IN ('suspended', 'deleted')
    `
    return {
      hostEarningsPoints: rows[0]?.earnings ?? 0n,
      hostCommissionPoints: rows[0]?.commission ?? 0n,
    }
  },

  /** Single-host earnings + commission sums from the daily table for a day range. */
  async sumHostDailyEarnings(
    agencyUserId: string,
    hostUserId: string,
    fromDay: Date,
    toDay: Date,
  ): Promise<{ hostEarningsPoints: bigint; hostCommissionPoints: bigint }> {
    const rows = await prismaRead.$queryRaw<{ earnings: bigint; commission: bigint }[]>`
      SELECT
        COALESCE(SUM(e.host_earnings_points), 0)::bigint AS earnings,
        COALESCE(SUM(e.host_commission_points), 0)::bigint AS commission
      FROM agency_daily_earnings e
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND e.host_user_id = ${hostUserId}::uuid
        AND e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
    `
    return {
      hostEarningsPoints: rows[0]?.earnings ?? 0n,
      hostCommissionPoints: rows[0]?.commission ?? 0n,
    }
  },

  async sumLiveDurationForAgency(
    agencyUserId: string,
    fromDay: Date,
    toDay: Date,
  ): Promise<bigint> {
    const rows = await prismaRead.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(SUM(e.live_duration_seconds), 0)::bigint AS s
      FROM agency_daily_earnings e
      INNER JOIN users u ON u.id = e.host_user_id
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND u.status NOT IN ('suspended', 'deleted')
    `
    return rows[0]?.s ?? 0n
  },

  async sumLiveDurationForHost(
    agencyUserId: string,
    hostUserId: string,
    fromDay: Date,
    toDay: Date,
  ): Promise<bigint> {
    const rows = await prismaRead.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(SUM(e.live_duration_seconds), 0)::bigint AS s
      FROM agency_daily_earnings e
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND e.host_user_id = ${hostUserId}::uuid
        AND e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
    `
    return rows[0]?.s ?? 0n
  },

  /** Point ledger aggregation for hosts currently under this agency (recompute-time filter uses daily table; this uses live membership). */
  async aggregateLedgerByTxTypeForAgencyHosts({
    agencyUserId,
    from,
    toExclusive,
  }: {
    agencyUserId: string
    from: Date
    toExclusive: Date
  }): Promise<Array<{ txType: string; totalAmount: bigint }>> {
    const rows = await prismaRead.$queryRaw<{ tx_type: string; s: bigint }[]>`
      SELECT ple.tx_type::text AS tx_type, COALESCE(SUM(ple.amount), 0)::bigint AS s
      FROM point_ledger_entries ple
      INNER JOIN wallets w ON w.id = ple.wallet_id
      INNER JOIN users u ON u.id = w.user_id
      WHERE w.currency_type = 'POINT'
        AND ple.direction = 'CREDIT'
        AND u.current_agency_id = ${agencyUserId}::uuid
        AND ple.created_at >= ${from}
        AND ple.created_at < ${toExclusive}
      GROUP BY ple.tx_type
    `
    return rows.map((r) => ({ txType: r.tx_type, totalAmount: r.s }))
  },

  async aggregateLedgerForSingleHost({
    hostUserId,
    agencyUserId,
    from,
    toExclusive,
  }: {
    hostUserId: string
    agencyUserId: string
    from: Date
    toExclusive: Date
  }): Promise<Array<{ txType: string; totalAmount: bigint }>> {
    const rows = await prismaRead.$queryRaw<{ tx_type: string; s: bigint }[]>`
      SELECT ple.tx_type::text AS tx_type, COALESCE(SUM(ple.amount), 0)::bigint AS s
      FROM point_ledger_entries ple
      INNER JOIN wallets w ON w.id = ple.wallet_id
      INNER JOIN users u ON u.id = w.user_id
      WHERE w.currency_type = 'POINT'
        AND ple.direction = 'CREDIT'
        AND w.user_id = ${hostUserId}::uuid
        AND u.current_agency_id = ${agencyUserId}::uuid
        AND ple.created_at >= ${from}
        AND ple.created_at < ${toExclusive}
      GROUP BY ple.tx_type
    `
    return rows.map((r) => ({ txType: r.tx_type, totalAmount: r.s }))
  },
}
