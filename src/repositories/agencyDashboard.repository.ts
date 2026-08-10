import type { PrismaClient } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { bigIntToStr, formatDuration } from '../utils/bigint'
import { endOfUTCDay, startOfUTCDay, toUTCDateOnly, utcNow } from '../utils/datetime'
import { buildUserDisplayName } from '../utils/user-display'

/**
 * Read-only aggregation repository for the agency agent dashboard.
 *
 * Most queries use `prismaRead` (read replica when configured).
 * `getAgentEarnedToday` uses primary (`prisma`) so post-gift commission
 * numbers are not held back by replica lag after Redis cache bust.
 * This module is strictly read-only — commission ledger writes happen in
 * `agencyCommissionService.applyCommission`.
 *
 * Agent-own-earnings eligible point credit types — drives the legacy
 * `agentOwnEarnings` / `totalEarnings` / `totalCommission` fields only.
 *
 * NOTE: this set is intentionally broader than agency commission eligibility
 * (`COMMISSION_ELIGIBLE_TX_TYPES` in `agencyCommission.service.ts`, which is now
 * GIFT_RECEIVE / VIDEO_CALL / LIVESTREAM_GIFT only). It is kept unchanged here to
 * preserve the existing agent-own response fields. The new `totalEarningsPoints`
 * field is computed purely from `agency_daily_earnings`
 * (host_earnings_points + host_commission_points) and does not use this list.
 */
const AGENT_OWN_EARNINGS_TX_TYPES = [
  'LIVESTREAM_GIFT',
  'GIFT_RECEIVE',
  'VIDEO_CALL',
  'SUBSCRIPTION',
] as const

export interface EarningsOverview {
  totalEarnings: string
  totalHostEarnings: string
  agentOwnEarnings: string
  totalHostCommission: string
  agentOwnCommission: string
  totalCommission: string
  /** Agency total economic activity for the period = host earnings + host commission. */
  totalEarningsPoints: string
  payrollCommission: string
  currentLevel: string
  currentRateBp: number
}

export interface HostDataSummary {
  totalHosts: number
  newHosts: number
  validHosts: number
  hostsWithIncome: number
  totalLiveDurationSeconds: string
  totalLiveDurationFormatted: string
  /** host earnings + host commission across all hosts for the period. */
  totalEarningsPoints: string
}

export interface HostCommissionItem {
  hostUserId: string
  displayName: string | null
  name: string | null
  avatarUrl: string | null
  publicId: string
  displayPublicId: string
  isTagged: boolean
  isVerified: boolean
  wealthLevel: number
  livestreamLevel: number
  hostEarnings: string
  commissionEarned: string
  /** hostEarnings + commissionEarned for this host within the period. */
  totalEarningsPoints: string
  liveDurationSeconds: string
  liveDurationFormatted: string
  isAgentSelf?: boolean
}

export interface HostDrilldown {
  hostUserId: string
  displayName: string | null
  name: string | null
  avatarUrl: string | null
  publicId: string
  displayPublicId: string
  age: number | null
  gender: string | null
  isTagged: boolean
  isVerified: boolean
  wealthLevel: number
  livestreamLevel: number
  remainingPoints: string
  hostEarnings: string
  commissionEarned: string
  /** hostEarnings + commissionEarned for this host within the period. */
  totalEarningsPoints: string
  liveDurationSeconds: string
  liveDurationFormatted: string
  platformHourlySalary: string
  rankReward: string
}

export interface AgentEarnedToday {
  earnedToday: string
  accumulatedEarnings: string
  pointsBalance: string
  /** host earnings + host commission for today (agency_daily_earnings). */
  totalEarningsPoints: string
}

async function getAgencyRateBp(agencyUserId: string): Promise<{ level: string; rateBp: number }> {
  const agency = await prismaRead.agency.findUnique({
    where: { userId: agencyUserId },
    select: { currentLevel: true },
  })
  const level = agency?.currentLevel ?? 'D'
  const levelConfig = await prismaRead.agencyCommissionLevel.findUnique({
    where: { level },
    select: { liveRateBp: true },
  })
  return { level, rateBp: levelConfig?.liveRateBp ?? 400 }
}

/** Sum the agent's own eligible point credits in `[start, end]` (inclusive instants). */
async function sumAgentOwnEarnings(
  agencyUserId: string,
  start: Date,
  end: Date,
  client: PrismaClient = prismaRead,
): Promise<bigint> {
  const [row] = await client.$queryRaw<Array<{ earned: bigint }>>`
    SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS earned
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id
    WHERE w.user_id       = ${agencyUserId}::uuid
      AND w.currency_type = 'POINT'
      AND ple.direction   = 'CREDIT'
      AND ple.tx_type::text = ANY(${[...AGENT_OWN_EARNINGS_TX_TYPES]}::text[])
      AND ple.created_at >= ${start}
      AND ple.created_at <= ${end}
  `
  return row?.earned ?? 0n
}

/** Current POINT wallet balance — Redis cache first, ledger fallback. */
async function getPointsBalance(
  userId: string,
  client: PrismaClient = prismaRead,
): Promise<bigint> {
  try {
    const cached = await redisClient.get(RedisKeys.walletPointBalance(userId))
    if (cached != null) return BigInt(cached)
  } catch {
    /* cache miss / parse error → fall through to DB */
  }
  const [row] = await client.$queryRaw<Array<{ bal: bigint }>>`
    SELECT COALESCE(
      SUM(CASE WHEN ple.direction = 'CREDIT' THEN ple.amount ELSE -ple.amount END),
      0
    )::BIGINT AS bal
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id
    WHERE w.user_id = ${userId}::uuid AND w.currency_type = 'POINT'
  `
  return row?.bal ?? 0n
}

export const agencyDashboardRepository = {
  /** Confirm a host currently belongs to this agency (drilldown security guard). */
  async verifyHostMembership(agencyUserId: string, hostUserId: string): Promise<boolean> {
    const membership = await prismaRead.agencyHost.findUnique({
      where: { hostUserId },
      select: { agencyUserId: true },
    })
    return membership?.agencyUserId === agencyUserId
  },

  async getEarningsOverview(
    agencyUserId: string,
    start: Date,
    end: Date,
  ): Promise<EarningsOverview> {
    const startDay = toUTCDateOnly(start)
    const endDay = toUTCDateOnly(end)

    // A: per-host aggregate from agency_daily_earnings.
    const [dailyAgg] = await prismaRead.$queryRaw<
      Array<{ totalHostEarnings: bigint; totalHostCommission: bigint }>
    >`
      SELECT
        COALESCE(SUM(host_earnings_points),   0)::BIGINT AS "totalHostEarnings",
        COALESCE(SUM(host_commission_points), 0)::BIGINT AS "totalHostCommission"
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid
        AND day BETWEEN ${startDay}::date AND ${endDay}::date
    `

    // C: agent payroll-processing reward credits in the period.
    const [payrollAgg] = await prismaRead.$queryRaw<Array<{ payrollCommission: bigint }>>`
      SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS "payrollCommission"
      FROM point_ledger_entries ple
      INNER JOIN wallets w ON w.id = ple.wallet_id
      WHERE w.user_id       = ${agencyUserId}::uuid
        AND w.currency_type = 'POINT'
        AND ple.direction   = 'CREDIT'
        AND ple.tx_type     = 'PAYROLL_PROCESSING_REWARD'
        AND ple.created_at >= ${start}
        AND ple.created_at <= ${end}
    `

    const [agentOwnEarnings, { level, rateBp }] = await Promise.all([
      sumAgentOwnEarnings(agencyUserId, start, end),
      getAgencyRateBp(agencyUserId),
    ])

    const agentOwnCommission = (agentOwnEarnings * BigInt(rateBp)) / 10_000n
    const totalHostEarnings = dailyAgg?.totalHostEarnings ?? 0n
    const totalHostCommission = dailyAgg?.totalHostCommission ?? 0n
    const totalEarnings = totalHostEarnings + agentOwnEarnings
    const totalCommission = totalHostCommission + agentOwnCommission
    // Agency total economic activity = host earnings + host commission. The
    // agent-as-own-host case is already captured in agency_daily_earnings, so no
    // special case is needed here.
    const totalEarningsPoints = totalHostEarnings + totalHostCommission

    return {
      totalEarnings: bigIntToStr(totalEarnings),
      totalHostEarnings: bigIntToStr(totalHostEarnings),
      agentOwnEarnings: bigIntToStr(agentOwnEarnings),
      totalHostCommission: bigIntToStr(totalHostCommission),
      agentOwnCommission: bigIntToStr(agentOwnCommission),
      totalCommission: bigIntToStr(totalCommission),
      totalEarningsPoints: bigIntToStr(totalEarningsPoints),
      payrollCommission: bigIntToStr(payrollAgg?.payrollCommission ?? 0n),
      currentLevel: level,
      currentRateBp: rateBp,
    }
  },

  async getHostDataSummary(agencyUserId: string, start: Date, end: Date): Promise<HostDataSummary> {
    // "new" hosts are always relative to NOW (current roster stat), not the period.
    const threeDaysAgo = new Date(utcNow().getTime() - 3 * 24 * 60 * 60 * 1000)
    const startDay = toUTCDateOnly(start)
    const endDay = toUTCDateOnly(end)

    const [counts] = await prismaRead.$queryRaw<
      Array<{ totalHosts: bigint; newHosts: bigint; validHosts: bigint }>
    >`
      SELECT
        COUNT(ah.host_user_id)::BIGINT AS "totalHosts",
        COUNT(ah.host_user_id) FILTER (WHERE ah.joined_at >= ${threeDaysAgo})::BIGINT
          AS "newHosts",
        COUNT(ah.host_user_id) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM user_face_profiles ufp
            WHERE ufp.user_id = ah.host_user_id AND ufp.status = 'INDEXED'
          )
          OR EXISTS (
            SELECT 1 FROM agency_application_kyc kc
            WHERE kc.user_id = ah.host_user_id AND kc.face_verified = true
          )
        )::BIGINT AS "validHosts"
      FROM agency_hosts ah
      WHERE ah.agency_user_id = ${agencyUserId}::uuid
    `

    const [incomeAndDuration] = await prismaRead.$queryRaw<
      Array<{ hostsWithIncome: bigint; totalLiveDuration: bigint; totalEarningsPoints: bigint }>
    >`
      SELECT
        COUNT(DISTINCT ade.host_user_id) FILTER (WHERE ade.host_earnings_points > 0)::BIGINT
          AS "hostsWithIncome",
        COALESCE((
          SELECT SUM(
            GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (ls.ended_at - ls.started_at)))
            )
          )::BIGINT
          FROM live_streams ls
          INNER JOIN agency_hosts ah
            ON ls.user_id::text = ah.host_user_id::text
           AND ah.agency_user_id = ${agencyUserId}::uuid
          WHERE ls.started_at IS NOT NULL
            AND ls.ended_at IS NOT NULL
            AND ls.ended_at > ls.started_at
            AND ls.started_at >= ah.joined_at
            AND ls.started_at >= (${startDay}::timestamp AT TIME ZONE 'UTC')
            AND ls.started_at < (((${endDay}::date + 1)::timestamp) AT TIME ZONE 'UTC')
        ), 0)::BIGINT AS "totalLiveDuration",
        COALESCE(SUM(ade.host_earnings_points + ade.host_commission_points), 0)::BIGINT
          AS "totalEarningsPoints"
      FROM agency_daily_earnings ade
      WHERE ade.agency_user_id = ${agencyUserId}::uuid
        AND ade.day BETWEEN ${startDay}::date AND ${endDay}::date
    `

    const totalLiveSecs = incomeAndDuration?.totalLiveDuration ?? 0n
    return {
      totalHosts: Number(counts?.totalHosts ?? 0n),
      newHosts: Number(counts?.newHosts ?? 0n),
      validHosts: Number(counts?.validHosts ?? 0n),
      hostsWithIncome: Number(incomeAndDuration?.hostsWithIncome ?? 0n),
      totalLiveDurationSeconds: bigIntToStr(totalLiveSecs),
      totalLiveDurationFormatted: formatDuration(totalLiveSecs),
      totalEarningsPoints: bigIntToStr(incomeAndDuration?.totalEarningsPoints ?? 0n),
    }
  },

  async getHostCommissionList(
    agencyUserId: string,
    start: Date,
    end: Date,
    limit: number,
    offset: number,
  ): Promise<{ items: HostCommissionItem[]; nextCursor: number | null; total: number }> {
    const startDay = toUTCDateOnly(start)
    const endDay = toUTCDateOnly(end)

    const rows = await prismaRead.$queryRaw<
      Array<{
        hostUserId: string
        hostEarnings: bigint
        commissionEarned: bigint
        liveDurationSeconds: bigint
        displayName: string | null
        firstName: string | null
        lastName: string | null
        avatarUrl: string | null
        publicId: bigint
        currentVipPublicId: bigint | null
        isTagged: boolean | null
        livestreamLevel: number | null
        wealthLevel: number | null
        faceVerified: boolean | null
      }>
    >`
      SELECT
        ade.host_user_id                                    AS "hostUserId",
        SUM(ade.host_earnings_points)::BIGINT               AS "hostEarnings",
        COALESCE(comm.commission, 0)::BIGINT                AS "commissionEarned",
        COALESCE(dur.live_duration, 0)::BIGINT              AS "liveDurationSeconds",
        u.username                                          AS "displayName",
        u.first_name                                        AS "firstName",
        u.last_name                                         AS "lastName",
        u.avatar_url                                        AS "avatarUrl",
        u.default_public_id                                 AS "publicId",
        u.current_vip_public_id                             AS "currentVipPublicId",
        u.is_tagged                                         AS "isTagged",
        wl_stream.current_level                             AS "livestreamLevel",
        wl_wealth.current_level                             AS "wealthLevel",
        (
          EXISTS (SELECT 1 FROM user_face_profiles ufp WHERE ufp.user_id = ade.host_user_id AND ufp.status = 'INDEXED')
          OR EXISTS (SELECT 1 FROM agency_application_kyc kc WHERE kc.user_id = ade.host_user_id AND kc.face_verified = true)
        )                                                   AS "faceVerified"
      FROM agency_daily_earnings ade
      INNER JOIN users u ON u.id = ade.host_user_id
      LEFT JOIN wallet_user_levels wl_stream
        ON wl_stream.user_id = ade.host_user_id AND wl_stream.level_type = 'LIVESTREAM'
      LEFT JOIN wallet_user_levels wl_wealth
        ON wl_wealth.user_id = ade.host_user_id AND wl_wealth.level_type = 'WEALTH'
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(ple.amount), 0)::bigint AS commission
        FROM point_ledger_entries ple
        INNER JOIN wallets w
          ON w.id = ple.wallet_id
         AND w.user_id = ${agencyUserId}::uuid
         AND w.currency_type = 'POINT'
        WHERE ple.tx_type = 'AGENT_COMMISSION'
          AND ple.direction = 'CREDIT'
          AND ple.counterparty_id = ade.host_user_id
          AND ple.created_at >= (${startDay}::timestamp AT TIME ZONE 'UTC')
          AND ple.created_at < (((${endDay}::date + 1)::timestamp) AT TIME ZONE 'UTC')
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
      ) comm ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(
                 SUM(
                   GREATEST(
                     0,
                     FLOOR(EXTRACT(EPOCH FROM (ls.ended_at - ls.started_at)))
                   )
                 ),
                 0
               )::bigint AS live_duration
        FROM live_streams ls
        INNER JOIN agency_hosts ah
          ON ls.user_id::text = ah.host_user_id::text
         AND ah.agency_user_id = ${agencyUserId}::uuid
        WHERE ls.user_id::text = ade.host_user_id::text
          AND ls.started_at IS NOT NULL
          AND ls.ended_at IS NOT NULL
          AND ls.ended_at > ls.started_at
          AND ls.started_at >= ah.joined_at
          AND ls.started_at >= (${startDay}::timestamp AT TIME ZONE 'UTC')
          AND ls.started_at < (((${endDay}::date + 1)::timestamp) AT TIME ZONE 'UTC')
      ) dur ON true
      WHERE ade.agency_user_id = ${agencyUserId}::uuid
        AND ade.day BETWEEN ${startDay}::date AND ${endDay}::date
      GROUP BY
        ade.host_user_id, u.username, u.first_name, u.last_name, u.avatar_url, u.default_public_id,
        u.current_vip_public_id, u.is_tagged, wl_stream.current_level, wl_wealth.current_level,
        comm.commission, dur.live_duration
      ORDER BY SUM(ade.host_earnings_points) DESC, ade.host_user_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `

    const [countRow] = await prismaRead.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(DISTINCT host_user_id)::BIGINT AS total
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid
        AND day BETWEEN ${startDay}::date AND ${endDay}::date
    `

    const items: HostCommissionItem[] = rows.map((r) => ({
      hostUserId: r.hostUserId,
      displayName: r.displayName ?? null,
      name: buildUserDisplayName({
        username: r.displayName ?? '',
        firstName: r.firstName,
        lastName: r.lastName,
      }),
      avatarUrl: r.avatarUrl ?? null,
      publicId: bigIntToStr(r.publicId),
      displayPublicId: bigIntToStr(r.currentVipPublicId ?? r.publicId),
      isTagged: r.isTagged ?? false,
      isVerified: r.faceVerified ?? false,
      wealthLevel: r.wealthLevel ?? 0,
      livestreamLevel: r.livestreamLevel ?? 0,
      hostEarnings: bigIntToStr(r.hostEarnings),
      commissionEarned: bigIntToStr(r.commissionEarned),
      totalEarningsPoints: bigIntToStr((r.hostEarnings ?? 0n) + (r.commissionEarned ?? 0n)),
      liveDurationSeconds: bigIntToStr(r.liveDurationSeconds),
      liveDurationFormatted: formatDuration(r.liveDurationSeconds ?? 0n),
    }))

    const total = Number(countRow?.total ?? 0n)
    const nextCursor = offset + limit < total ? offset + limit : null
    return { items, nextCursor, total }
  },

  async getHostDrilldown(
    agencyUserId: string,
    hostUserId: string,
    start: Date,
    end: Date,
  ): Promise<HostDrilldown> {
    const startDay = toUTCDateOnly(start)
    const endDay = toUTCDateOnly(end)

    const [agg] = await prismaRead.$queryRaw<
      Array<{
        hostEarnings: bigint
        commissionEarned: bigint
        liveDurationSeconds: bigint
      }>
    >`
      SELECT
        COALESCE(SUM(ade.host_earnings_points), 0)::BIGINT AS "hostEarnings",
        COALESCE((
          SELECT SUM(ple.amount)::bigint
          FROM point_ledger_entries ple
          INNER JOIN wallets w
            ON w.id = ple.wallet_id
           AND w.user_id = ${agencyUserId}::uuid
           AND w.currency_type = 'POINT'
          WHERE ple.tx_type = 'AGENT_COMMISSION'
            AND ple.direction = 'CREDIT'
            AND ple.counterparty_id = ${hostUserId}::uuid
            AND ple.created_at >= (${startDay}::timestamp AT TIME ZONE 'UTC')
            AND ple.created_at < (((${endDay}::date + 1)::timestamp) AT TIME ZONE 'UTC')
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
        ), 0)::BIGINT AS "commissionEarned",
        COALESCE((
          SELECT SUM(
            GREATEST(
              0,
              FLOOR(EXTRACT(EPOCH FROM (ls.ended_at - ls.started_at)))
            )
          )::bigint
          FROM live_streams ls
          INNER JOIN agency_hosts ah
            ON ls.user_id::text = ah.host_user_id::text
           AND ah.agency_user_id = ${agencyUserId}::uuid
          WHERE ls.user_id::text = ${hostUserId}
            AND ls.started_at IS NOT NULL
            AND ls.ended_at IS NOT NULL
            AND ls.ended_at > ls.started_at
            AND ls.started_at >= ah.joined_at
            AND ls.started_at >= (${startDay}::timestamp AT TIME ZONE 'UTC')
            AND ls.started_at < (((${endDay}::date + 1)::timestamp) AT TIME ZONE 'UTC')
        ), 0)::BIGINT AS "liveDurationSeconds"
      FROM agency_daily_earnings ade
      WHERE ade.agency_user_id = ${agencyUserId}::uuid
        AND ade.host_user_id   = ${hostUserId}::uuid
        AND ade.day BETWEEN ${startDay}::date AND ${endDay}::date
    `

    const [user, levels, faceProfile, kycRow, pointsBalance] = await Promise.all([
      prismaRead.user.findUnique({
        where: { id: hostUserId },
        select: {
          username: true,
          firstName: true,
          lastName: true,
          avatarUrl: true,
          defaultPublicId: true,
          currentVipPublicId: true,
          dateOfBirth: true,
          gender: true,
          isTagged: true,
          hourlyWage: true,
        },
      }),
      prismaRead.walletUserLevel.findMany({
        where: { userId: hostUserId, levelType: { in: ['LIVESTREAM', 'WEALTH'] } },
        select: { levelType: true, currentLevel: true },
      }),
      prismaRead.userFaceProfile.findUnique({
        where: { userId: hostUserId },
        select: { status: true },
      }),
      prismaRead.agencyApplicationKyc.findUnique({
        where: { userId: hostUserId },
        select: { faceVerified: true },
      }),
      getPointsBalance(hostUserId),
    ])

    const wealthLevel = levels.find((l) => l.levelType === 'WEALTH')?.currentLevel ?? 0
    const livestreamLevel = levels.find((l) => l.levelType === 'LIVESTREAM')?.currentLevel ?? 0
    const isVerified = faceProfile?.status === 'INDEXED' || kycRow?.faceVerified === true

    const age = user?.dateOfBirth
      ? Math.floor(
          (Date.now() - new Date(user.dateOfBirth).getTime()) / (365.25 * 24 * 3600 * 1000),
        )
      : null

    return {
      hostUserId,
      displayName: user?.username ?? null,
      name: user
        ? buildUserDisplayName({
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
          })
        : null,
      avatarUrl: user?.avatarUrl ?? null,
      publicId: bigIntToStr(user?.defaultPublicId),
      displayPublicId: bigIntToStr(user?.currentVipPublicId ?? user?.defaultPublicId),
      age,
      gender: user?.gender ?? null,
      isTagged: user?.isTagged ?? false,
      isVerified,
      wealthLevel,
      livestreamLevel,
      remainingPoints: bigIntToStr(pointsBalance),
      hostEarnings: bigIntToStr(agg?.hostEarnings ?? 0n),
      commissionEarned: bigIntToStr(agg?.commissionEarned ?? 0n),
      totalEarningsPoints: bigIntToStr((agg?.hostEarnings ?? 0n) + (agg?.commissionEarned ?? 0n)),
      liveDurationSeconds: bigIntToStr(agg?.liveDurationSeconds ?? 0n),
      liveDurationFormatted: formatDuration(agg?.liveDurationSeconds ?? 0n),
      platformHourlySalary: bigIntToStr(user?.hourlyWage ?? 0n),
      rankReward: '0',
    }
  },

  async getAgentEarnedToday(agencyUserId: string): Promise<AgentEarnedToday> {
    const now = utcNow()
    const todayStart = startOfUTCDay(now)
    const todayEnd = endOfUTCDay(now)
    const todayDay = toUTCDateOnly(now)
    // Primary: avoid serving pre-gift totals right after dashboard Redis bust.
    const db = prisma

    const [todayAgg] = await db.$queryRaw<Array<{ earned: bigint }>>`
      SELECT COALESCE(SUM(host_earnings_points + host_commission_points), 0)::BIGINT AS earned
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid AND day = ${todayDay}::date
    `

    const [allTimeAgg] = await db.$queryRaw<Array<{ earned: bigint }>>`
      SELECT COALESCE(SUM(host_earnings_points + host_commission_points), 0)::BIGINT AS earned
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid
    `

    const [ownToday, ownAllTime, pointsBalance] = await Promise.all([
      sumAgentOwnEarnings(agencyUserId, todayStart, todayEnd, db),
      // All-time agent own eligible credits (no lower bound).
      db
        .$queryRaw<Array<{ earned: bigint }>>`
          SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS earned
          FROM point_ledger_entries ple
          INNER JOIN wallets w ON w.id = ple.wallet_id
          WHERE w.user_id       = ${agencyUserId}::uuid
            AND w.currency_type = 'POINT'
            AND ple.direction   = 'CREDIT'
            AND ple.tx_type::text = ANY(${[...AGENT_OWN_EARNINGS_TX_TYPES]}::text[])
        `
        .then((rows) => rows[0]?.earned ?? 0n),
      getPointsBalance(agencyUserId, db),
    ])

    const earnedToday = (todayAgg?.earned ?? 0n) + ownToday
    const accumulatedEarnings = (allTimeAgg?.earned ?? 0n) + ownAllTime

    return {
      earnedToday: bigIntToStr(earnedToday),
      accumulatedEarnings: bigIntToStr(accumulatedEarnings),
      pointsBalance: bigIntToStr(pointsBalance),
      // host earnings + host commission for today (agency_daily_earnings already
      // includes the agent-as-own-host rows).
      totalEarningsPoints: bigIntToStr(todayAgg?.earned ?? 0n),
    }
  },
}
