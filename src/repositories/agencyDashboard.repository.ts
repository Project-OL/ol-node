import { prismaRead } from '../config/database'
import { redisClient, RedisKeys } from '../config/redis'
import { bigIntToStr, formatDuration } from '../utils/bigint'
import { endOfUTCDay, startOfUTCDay, toUTCDateOnly, utcNow } from '../utils/datetime'

/**
 * Read-only aggregation repository for the agency agent dashboard.
 *
 * All queries use `prismaRead` (read replica when configured). This module is
 * strictly read-only — commission ledger writes happen in
 * `agencyCommissionService.applyCommission`.
 *
 * Agent-own-earnings eligible point credit types. Kept in sync with
 * `COMMISSION_ELIGIBLE_TX_TYPES` in `agencyCommission.service.ts` so an agent's
 * own gifting/call/subscription credits are counted the same way host
 * commission eligibility is computed.
 */
const COMMISSION_ELIGIBLE_TX_TYPES = [
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
}

export interface HostCommissionItem {
  hostUserId: string
  displayName: string | null
  avatarUrl: string | null
  publicId: string
  displayPublicId: string
  isTagged: boolean
  isVerified: boolean
  wealthLevel: number
  livestreamLevel: number
  hostEarnings: string
  commissionEarned: string
  liveDurationSeconds: string
  liveDurationFormatted: string
  isAgentSelf?: boolean
}

export interface HostDrilldown {
  hostUserId: string
  displayName: string | null
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
  liveDurationSeconds: string
  liveDurationFormatted: string
  platformHourlySalary: string
  rankReward: string
}

export interface AgentEarnedToday {
  earnedToday: string
  accumulatedEarnings: string
  pointsBalance: string
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
async function sumAgentOwnEarnings(agencyUserId: string, start: Date, end: Date): Promise<bigint> {
  const [row] = await prismaRead.$queryRaw<Array<{ earned: bigint }>>`
    SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS earned
    FROM point_ledger_entries ple
    INNER JOIN wallets w ON w.id = ple.wallet_id
    WHERE w.user_id       = ${agencyUserId}::uuid
      AND w.currency_type = 'POINT'
      AND ple.direction   = 'CREDIT'
      AND ple.tx_type::text = ANY(${[...COMMISSION_ELIGIBLE_TX_TYPES]}::text[])
      AND ple.created_at >= ${start}
      AND ple.created_at <= ${end}
  `
  return row?.earned ?? 0n
}

/** Current POINT wallet balance — Redis cache first, ledger fallback. */
async function getPointsBalance(userId: string): Promise<bigint> {
  try {
    const cached = await redisClient.get(RedisKeys.walletPointBalance(userId))
    if (cached != null) return BigInt(cached)
  } catch {
    /* cache miss / parse error → fall through to DB */
  }
  const [row] = await prismaRead.$queryRaw<Array<{ bal: bigint }>>`
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

    return {
      totalEarnings: bigIntToStr(totalEarnings),
      totalHostEarnings: bigIntToStr(totalHostEarnings),
      agentOwnEarnings: bigIntToStr(agentOwnEarnings),
      totalHostCommission: bigIntToStr(totalHostCommission),
      agentOwnCommission: bigIntToStr(agentOwnCommission),
      totalCommission: bigIntToStr(totalCommission),
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
      Array<{ hostsWithIncome: bigint; totalLiveDuration: bigint }>
    >`
      SELECT
        COUNT(DISTINCT ade.host_user_id) FILTER (WHERE ade.host_earnings_points > 0)::BIGINT
          AS "hostsWithIncome",
        COALESCE(SUM(ade.live_duration_seconds), 0)::BIGINT AS "totalLiveDuration"
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
        SUM(ade.host_commission_points)::BIGINT             AS "commissionEarned",
        COALESCE(SUM(ade.live_duration_seconds), 0)::BIGINT AS "liveDurationSeconds",
        u.username                                          AS "displayName",
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
      WHERE ade.agency_user_id = ${agencyUserId}::uuid
        AND ade.day BETWEEN ${startDay}::date AND ${endDay}::date
      GROUP BY
        ade.host_user_id, u.username, u.avatar_url, u.default_public_id,
        u.current_vip_public_id, u.is_tagged, wl_stream.current_level, wl_wealth.current_level
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
      avatarUrl: r.avatarUrl ?? null,
      publicId: bigIntToStr(r.publicId),
      displayPublicId: bigIntToStr(r.currentVipPublicId ?? r.publicId),
      isTagged: r.isTagged ?? false,
      isVerified: r.faceVerified ?? false,
      wealthLevel: r.wealthLevel ?? 0,
      livestreamLevel: r.livestreamLevel ?? 0,
      hostEarnings: bigIntToStr(r.hostEarnings),
      commissionEarned: bigIntToStr(r.commissionEarned),
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
        COALESCE(SUM(host_earnings_points),   0)::BIGINT AS "hostEarnings",
        COALESCE(SUM(host_commission_points), 0)::BIGINT AS "commissionEarned",
        COALESCE(SUM(live_duration_seconds),  0)::BIGINT AS "liveDurationSeconds"
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid
        AND host_user_id   = ${hostUserId}::uuid
        AND day BETWEEN ${startDay}::date AND ${endDay}::date
    `

    const [user, levels, faceProfile, kycRow, pointsBalance] = await Promise.all([
      prismaRead.user.findUnique({
        where: { id: hostUserId },
        select: {
          username: true,
          avatarUrl: true,
          defaultPublicId: true,
          currentVipPublicId: true,
          dateOfBirth: true,
          gender: true,
          isTagged: true,
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
      liveDurationSeconds: bigIntToStr(agg?.liveDurationSeconds ?? 0n),
      liveDurationFormatted: formatDuration(agg?.liveDurationSeconds ?? 0n),
      platformHourlySalary: '0',
      rankReward: '0',
    }
  },

  async getAgentEarnedToday(agencyUserId: string): Promise<AgentEarnedToday> {
    const now = utcNow()
    const todayStart = startOfUTCDay(now)
    const todayEnd = endOfUTCDay(now)
    const todayDay = toUTCDateOnly(now)

    const [todayAgg] = await prismaRead.$queryRaw<Array<{ earned: bigint }>>`
      SELECT COALESCE(SUM(host_earnings_points + host_commission_points), 0)::BIGINT AS earned
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid AND day = ${todayDay}::date
    `

    const [allTimeAgg] = await prismaRead.$queryRaw<Array<{ earned: bigint }>>`
      SELECT COALESCE(SUM(host_earnings_points + host_commission_points), 0)::BIGINT AS earned
      FROM agency_daily_earnings
      WHERE agency_user_id = ${agencyUserId}::uuid
    `

    const [ownToday, ownAllTime, pointsBalance] = await Promise.all([
      sumAgentOwnEarnings(agencyUserId, todayStart, todayEnd),
      // All-time agent own eligible credits (no lower bound).
      prismaRead.$queryRaw<Array<{ earned: bigint }>>`
          SELECT COALESCE(SUM(ple.amount), 0)::BIGINT AS earned
          FROM point_ledger_entries ple
          INNER JOIN wallets w ON w.id = ple.wallet_id
          WHERE w.user_id       = ${agencyUserId}::uuid
            AND w.currency_type = 'POINT'
            AND ple.direction   = 'CREDIT'
            AND ple.tx_type::text = ANY(${[...COMMISSION_ELIGIBLE_TX_TYPES]}::text[])
        `.then((rows) => rows[0]?.earned ?? 0n),
      getPointsBalance(agencyUserId),
    ])

    const earnedToday = (todayAgg?.earned ?? 0n) + ownToday
    const accumulatedEarnings = (allTimeAgg?.earned ?? 0n) + ownAllTime

    return {
      earnedToday: bigIntToStr(earnedToday),
      accumulatedEarnings: bigIntToStr(accumulatedEarnings),
      pointsBalance: bigIntToStr(pointsBalance),
    }
  },
}
