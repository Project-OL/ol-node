import { CoinTxType, WalletCurrencyType, type Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

const PERSONAL_RECHARGE_TX_TYPES: CoinTxType[] = [
  CoinTxType.TOPUP,
  CoinTxType.TRADING_TRANSFER_IN,
  CoinTxType.ADJUSTMENT,
]

export const adminUserDetailSelect = {
  id: true,
  username: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  vipPublicIdExpiresAt: true,
  vipSubscriptionActive: true,
  vipSubscriptionExpiresAt: true,
  firstName: true,
  lastName: true,
  gender: true,
  country: true,
  avatarUrl: true,
  bio: true,
  status: true,
  suspendedUntil: true,
  personalCoinsFrozen: true,
  tradingCoinsFrozen: true,
  pointsFrozen: true,
  postingSuspendedUntil: true,
  postingBanned: true,
  adminTags: true,
  createdAt: true,
  lastActiveAt: true,
  lastIpAddress: true,
  isAgent: true,
  authIdentifiers: {
    where: { provider: { in: ['email', 'phone'] } },
    select: {
      provider: true,
      identifier: true,
      isVerified: true,
      isPrimary: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as Prisma.UserSelect

export type AdminUserDetailRow = {
  id: string
  username: string
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  vipPublicIdExpiresAt: Date | null
  vipSubscriptionActive: boolean
  vipSubscriptionExpiresAt: Date | null
  firstName: string | null
  lastName: string | null
  gender: string | null
  country: string | null
  avatarUrl: string | null
  bio: string | null
  status: string
  suspendedUntil: Date | null
  personalCoinsFrozen: boolean
  tradingCoinsFrozen: boolean
  pointsFrozen: boolean
  postingSuspendedUntil: Date | null
  postingBanned: boolean
  adminTags: string[]
  createdAt: Date
  lastActiveAt: Date | null
  lastIpAddress: string | null
  isAgent: boolean
  authIdentifiers: Array<{
    provider: string
    identifier: string
    isVerified: boolean
    isPrimary: boolean
  }>
}

export const adminUserDetailRepository = {
  async findUser(userId: string): Promise<AdminUserDetailRow | null> {
    return prismaRead.user.findUnique({
      where: { id: userId },
      select: adminUserDetailSelect,
    }) as Promise<AdminUserDetailRow | null>
  },

  async getLatestSession(userId: string) {
    return prismaRead.session.findFirst({
      where: { userId },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        lastActiveAt: true,
        deviceId: true,
        deviceName: true,
        ipAddress: true,
      },
    })
  },

  async getLatestDevice(userId: string) {
    return prismaRead.deviceRegistry.findFirst({
      where: { userId },
      orderBy: { lastActiveAt: 'desc' },
      select: {
        deviceId: true,
        deviceName: true,
        ipAddress: true,
        lastActiveAt: true,
      },
    })
  },

  async sumPersonalCoinRecharge(userId: string): Promise<bigint> {
    const wallet = await prismaRead.wallet.findUnique({
      where: { userId_currencyType: { userId, currencyType: WalletCurrencyType.COIN } },
      select: { id: true },
    })
    if (!wallet) return 0n
    const agg = await prismaRead.coinLedgerEntry.aggregate({
      where: {
        walletId: wallet.id,
        direction: 'CREDIT',
        txType: { in: PERSONAL_RECHARGE_TX_TYPES },
      },
      _sum: { amount: true },
    })
    return agg._sum.amount ?? 0n
  },

  async sumProcessedWithdrawals(userId: string): Promise<bigint> {
    const agg = await prismaRead.withdrawal.aggregate({
      where: { userId, status: 'PAID' },
      _sum: { amountPoints: true },
    })
    return agg._sum.amountPoints ?? 0n
  },

  /**
   * Club effective live seconds for streams that ended in `[start, end)` —
   * same definition as Live-server `getHostStatsService` (period=this_week).
   * When `effective_duration_seconds` is still 0 (failed/missing write), use wall-clock.
   */
  async sumEffectiveLiveSecondsInRange(
    userId: string,
    start: Date,
    end: Date,
  ): Promise<number> {
    const rows = await prismaRead.$queryRaw<Array<{ total: bigint | number | null }>>`
      SELECT COALESCE(SUM(
        CASE
          WHEN effective_duration_seconds > 0 THEN effective_duration_seconds
          WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
            THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ended_at - started_at)))::int)
          ELSE 0
        END
      ), 0) AS total
      FROM live_streams
      WHERE user_id = ${userId}::uuid
        AND ended_at >= ${start}
        AND ended_at < ${end}
    `
    return Number(rows[0]?.total ?? 0)
  },

  /** POINT wallet credits in `[start, end)` — Live-server host-stats `wonPoints`. */
  async sumPointCreditsInRange(userId: string, start: Date, end: Date): Promise<bigint> {
    const wallet = await prismaRead.wallet.findUnique({
      where: { userId_currencyType: { userId, currencyType: WalletCurrencyType.POINT } },
      select: { id: true },
    })
    if (!wallet) return 0n
    const agg = await prismaRead.pointLedgerEntry.aggregate({
      where: {
        walletId: wallet.id,
        direction: 'CREDIT',
        createdAt: { gte: start, lt: end },
      },
      _sum: { amount: true },
    })
    return agg._sum.amount ?? 0n
  },

  async countNewFollowersInRange(userId: string, start: Date, end: Date): Promise<number> {
    return prismaRead.userFollow.count({
      where: {
        followingId: userId,
        createdAt: { gte: start, lt: end },
      },
    })
  },
}
