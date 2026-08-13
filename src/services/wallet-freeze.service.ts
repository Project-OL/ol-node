import { Prisma, WalletCurrencyType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

export type UserWalletFreezeFlags = {
  personalCoinsFrozen: boolean
  tradingCoinsFrozen: boolean
  pointsFrozen: boolean
}

const freezeSelect = {
  personalCoinsFrozen: true,
  tradingCoinsFrozen: true,
  pointsFrozen: true,
} as const

export async function getUserWalletFreezeFlags(
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prismaRead,
): Promise<UserWalletFreezeFlags> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: freezeSelect,
  })
  if (!row) {
    throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
  }
  return row
}

function throwIfCoinFrozen(flags: UserWalletFreezeFlags, currencyType: WalletCurrencyType): void {
  if (currencyType === WalletCurrencyType.COIN && flags.personalCoinsFrozen) {
    throw new AppError(403, 'Personal coins are frozen', 'PERSONAL_COINS_FROZEN')
  }
  if (currencyType === WalletCurrencyType.TRADING_COIN && flags.tradingCoinsFrozen) {
    throw new AppError(403, 'Trading coins are frozen', 'TRADING_COINS_FROZEN')
  }
}

export async function assertCoinDebitAllowed(
  userId: string,
  currencyType: WalletCurrencyType,
): Promise<void> {
  throwIfCoinFrozen(await getUserWalletFreezeFlags(userId), currencyType)
}

/** Re-check freeze on the primary (or tx) after the wallet row is locked. */
export async function assertCoinDebitAllowedInTx(
  tx: Prisma.TransactionClient,
  userId: string,
  currencyType: WalletCurrencyType,
): Promise<void> {
  throwIfCoinFrozen(await getUserWalletFreezeFlags(userId, tx), currencyType)
}

export async function assertPointsDebitAllowed(userId: string): Promise<void> {
  const flags = await getUserWalletFreezeFlags(userId)
  if (flags.pointsFrozen) {
    throw new AppError(403, 'Points are frozen', 'POINTS_FROZEN')
  }
}

export async function assertPointsDebitAllowedInTx(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  const flags = await getUserWalletFreezeFlags(userId, tx)
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
