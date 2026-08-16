import { LedgerDirection, LevelType, WalletCurrencyType } from '@prisma/client'
import { prisma } from '../config/database'
import { walletUserLevelRepository } from '../repositories/wallet-user-level.repository'
import { computeLevel, walletLevelService } from '../services/user-level.service'

export async function runWalletLevelBackfillForUser(userId: string): Promise<void> {
  const coinWallet = await prisma.wallet.findFirst({
    where: { userId, currencyType: WalletCurrencyType.COIN },
  })
  if (coinWallet) {
    const agg = await prisma.coinLedgerEntry.aggregate({
      where: { walletId: coinWallet.id, direction: LedgerDirection.CREDIT },
      _sum: { amount: true },
    })
    const totalCoins = agg._sum.amount ?? 0n
    const thresholds = await walletUserLevelRepository.getConfigs(LevelType.WEALTH)
    const level = computeLevel(
      totalCoins,
      thresholds.map((c) => ({ level: c.level, threshold: c.threshold })),
    )
    await walletUserLevelRepository.getOrCreate(userId, LevelType.WEALTH)
    await prisma.walletUserLevel.update({
      where: { userId_levelType: { userId, levelType: LevelType.WEALTH } },
      data: { currentLevel: level, cumulativeTotal: totalCoins },
    })
  }

  const pointWallet = await prisma.wallet.findFirst({
    where: { userId, currencyType: WalletCurrencyType.POINT },
  })
  if (pointWallet) {
    const agg = await prisma.pointLedgerEntry.aggregate({
      where: { walletId: pointWallet.id, direction: LedgerDirection.CREDIT },
      _sum: { amount: true },
    })
    const totalPoints = agg._sum.amount ?? 0n
    const thresholds = await walletUserLevelRepository.getConfigs(LevelType.LIVESTREAM)
    const level = computeLevel(
      totalPoints,
      thresholds.map((c) => ({ level: c.level, threshold: c.threshold })),
    )
    await walletUserLevelRepository.getOrCreate(userId, LevelType.LIVESTREAM)
    await prisma.walletUserLevel.update({
      where: { userId_levelType: { userId, levelType: LevelType.LIVESTREAM } },
      data: { currentLevel: level, cumulativeTotal: totalPoints },
    })
  }

  await walletLevelService.invalidateCache(userId, LevelType.WEALTH)
  await walletLevelService.invalidateCache(userId, LevelType.LIVESTREAM)
}
