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
}
