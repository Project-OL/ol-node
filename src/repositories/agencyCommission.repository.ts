import { Prisma } from "@prisma/client";
import { prismaRead } from "../config/database";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export type AgencyCommissionLevelRow = {
  level: string;
  minWindowPoints: bigint;
  liveRateBp: number;
  matchChatRateBp: number;
  sortOrder: number;
};

export const agencyCommissionRepository = {
  async getLevelConfig(): Promise<AgencyCommissionLevelRow[]> {
    const rows = await prismaRead.agencyCommissionLevel.findMany({
      orderBy: { sortOrder: "asc" },
    });
    return rows.map((r) => ({
      level: r.level,
      minWindowPoints: r.minWindowPoints,
      liveRateBp: r.liveRateBp,
      matchChatRateBp: r.matchChatRateBp,
      sortOrder: r.sortOrder,
    }));
  },

  async getLevelRow(level: string): Promise<AgencyCommissionLevelRow | null> {
    const r = await prismaRead.agencyCommissionLevel.findUnique({
      where: { level },
    });
    if (!r) return null;
    return {
      level: r.level,
      minWindowPoints: r.minWindowPoints,
      liveRateBp: r.liveRateBp,
      matchChatRateBp: r.matchChatRateBp,
      sortOrder: r.sortOrder,
    };
  },

  async upsertDailyEarning(
    {
      agencyUserId,
      hostUserId,
      day,
      hostEarningsDelta,
      hostCommissionDelta,
    }: {
      agencyUserId: string;
      hostUserId: string;
      day: Date;
      hostEarningsDelta: bigint;
      hostCommissionDelta: bigint;
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
        ${hostEarningsDelta},
        ${hostCommissionDelta},
        true,
        NOW()
      )
      ON CONFLICT (agency_user_id, host_user_id, day) DO UPDATE SET
        host_earnings_points = agency_daily_earnings.host_earnings_points + EXCLUDED.host_earnings_points,
        host_commission_points = agency_daily_earnings.host_commission_points + EXCLUDED.host_commission_points,
        host_was_active = true,
        last_credit_at = NOW()
    `;
  },

  async getAgencyWindowTotal(
    agencyUserId: string,
    fromDay: Date,
    toDay: Date,
  ): Promise<bigint> {
    const rows = await prismaRead.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(SUM(e.host_earnings_points), 0)::bigint AS s
      FROM agency_daily_earnings e
      INNER JOIN users u ON u.id = e.host_user_id
      WHERE e.agency_user_id = ${agencyUserId}::uuid
        AND e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND e.host_was_active = true
        AND u.status NOT IN ('suspended', 'deleted')
    `;
    return rows[0]?.s ?? 0n;
  },

  async listAgenciesForRecompute({
    fromDay,
    toDay,
    cursor,
    limit,
  }: {
    fromDay: Date;
    toDay: Date;
    cursor: string | null;
    limit: number;
  }): Promise<string[]> {
    const cur = cursor && cursor.length > 0 ? cursor : ZERO_UUID;
    const rows = await prismaRead.$queryRaw<{ agency_user_id: string }[]>`
      SELECT DISTINCT e.agency_user_id
      FROM agency_daily_earnings e
      WHERE e.day >= ${fromDay}::date
        AND e.day <= ${toDay}::date
        AND e.agency_user_id > ${cur}::uuid
      ORDER BY e.agency_user_id ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => r.agency_user_id);
  },

  /** Per-host totals from daily earnings (commission panel). */
  async sumHostEarningsByHost(
    agencyUserId: string,
    fromDay: Date,
    toDay: Date,
    opts?: { limit: number; offset: number },
  ): Promise<
    Array<{
      hostUserId: string;
      hostEarningsPoints: bigint;
      hostCommissionPoints: bigint;
      liveDurationSeconds: bigint;
    }>
  > {
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;
    const rows = await prismaRead.$queryRaw<
      {
        host_user_id: string;
        earnings: bigint;
        commission: bigint;
        live_duration: bigint;
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
    `;
    return rows.map((r) => ({
      hostUserId: r.host_user_id,
      hostEarningsPoints: r.earnings,
      hostCommissionPoints: r.commission,
      liveDurationSeconds: r.live_duration,
    }));
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
    `;
    return rows[0]?.s ?? 0n;
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
    `;
    return rows[0]?.s ?? 0n;
  },

  /** Point ledger aggregation for hosts currently under this agency (recompute-time filter uses daily table; this uses live membership). */
  async aggregateLedgerByTxTypeForAgencyHosts({
    agencyUserId,
    from,
    toExclusive,
  }: {
    agencyUserId: string;
    from: Date;
    toExclusive: Date;
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
    `;
    return rows.map((r) => ({ txType: r.tx_type, totalAmount: r.s }));
  },

  async aggregateLedgerForSingleHost({
    hostUserId,
    agencyUserId,
    from,
    toExclusive,
  }: {
    hostUserId: string;
    agencyUserId: string;
    from: Date;
    toExclusive: Date;
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
    `;
    return rows.map((r) => ({ txType: r.tx_type, totalAmount: r.s }));
  },
};
