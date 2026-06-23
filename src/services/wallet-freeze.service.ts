import { WalletCurrencyType } from '@prisma/client'
import { prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

export type UserWalletFreezeFlags = {
  personalCoinsFrozen: boolean
  tradingCoinsFrozen: boolean
  pointsFrozen: boolean
}

export async function getUserWalletFreezeFlags(userId: string): Promise<UserWalletFreezeFlags> {
  const row = await prismaRead.user.findUnique({
    where: { id: userId },
    select: {
      personalCoinsFrozen: true,
      tradingCoinsFrozen: true,
      pointsFrozen: true,
    },
  })
  if (!row) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
  }
  return row
}

export async function assertCoinDebitAllowed(
  userId: string,
  currencyType: WalletCurrencyType,
): Promise<void> {
  const flags = await getUserWalletFreezeFlags(userId)
  if (currencyType === WalletCurrencyType.COIN && flags.personalCoinsFrozen) {
    throw new AppError(403, 'Personal coins are frozen', 'PERSONAL_COINS_FROZEN')
  }
  if (currencyType === WalletCurrencyType.TRADING_COIN && flags.tradingCoinsFrozen) {
    throw new AppError(403, 'Trading coins are frozen', 'TRADING_COINS_FROZEN')
  }
}

export async function assertPointsDebitAllowed(userId: string): Promise<void> {
  const flags = await getUserWalletFreezeFlags(userId)
  if (flags.pointsFrozen) {
    throw new AppError(403, 'Points are frozen', 'POINTS_FROZEN')
  }
}

export async function assertUserMayPost(userId: string): Promise<void> {
  const row = await prismaRead.user.findUnique({
    where: { id: userId },
    select: { postingBanned: true, postingSuspendedUntil: true },
  })
  if (!row) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
  if (row.postingBanned) {
    throw new AppError(403, 'Posting is permanently banned', 'POSTING_BANNED')
  }
  if (row.postingSuspendedUntil && row.postingSuspendedUntil > new Date()) {
    throw new AppError(403, 'Posting is suspended', 'POSTING_SUSPENDED', {
      suspendedUntil: row.postingSuspendedUntil.toISOString(),
    })
  }
}
