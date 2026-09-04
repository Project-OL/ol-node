import { CoinTxType, DiamondConversionDirection, WalletCurrencyType } from '@prisma/client'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { walletRepository } from '../repositories/wallet.repository'
import { coinWalletService } from './coin-wallet.service'
import { diamondWalletService } from './diamond-wallet.service'
import { walletService } from './wallet.service'
import { lockWalletsInOrder } from '../utils/wallet-lock-order'
import { withSerializationRetry, isUniqueViolation } from '../utils/txRetry'

const TX_TIMEOUT_MS = 20_000

async function findExistingConversion(idempotencyKey: string) {
  return prisma.diamondConversion.findUnique({ where: { idempotencyKey } })
}

/**
 * Coin↔Diamond conversion — 1:1, since both are pegged at 10,000 units = $1 USD (the
 * platform-wide convention, see `src/utils/points-currency.ts`). No spread/fee: company
 * revenue comes entirely from the house edge captured in `game-round-ledger-link.service.ts`,
 * not from the conversion itself. Every leg is an ordinary `CoinLedgerEntry` on the user's
 * existing COIN wallet (shows up in `/wallet/coins/history` automatically) and DIAMOND wallet.
 */
export const diamondConversionService = {
  async buyDiamonds(userId: string, coinAmount: bigint, idempotencyKey: string) {
    if (coinAmount <= 0n) {
      throw new AppError(400, 'coinAmount must be positive', 'INVALID_AMOUNT')
    }
    const key = `diamond-buy:${userId}:${idempotencyKey}`
    const diamondAmount = coinAmount

    const runConversion = () =>
      prisma.$transaction(
        async (tx) => {
          const existing = await tx.diamondConversion.findUnique({
            where: { idempotencyKey: key },
          })
          if (existing) return existing

          const coinWallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.COIN, tx)
          const diamondWallet = await walletRepository.getOrCreate(
            userId,
            WalletCurrencyType.DIAMOND,
            tx,
          )
          await lockWalletsInOrder(tx, [coinWallet, diamondWallet])

          const coinDebit = await coinWalletService.debit(
            userId,
            coinAmount,
            CoinTxType.DIAMOND_PURCHASE_OUT,
            tx,
            { idempotencyKey: `${key}:out`, description: 'Diamonds purchased' },
          )
          const diamondCredit = await diamondWalletService.credit(
            userId,
            diamondAmount,
            CoinTxType.DIAMOND_PURCHASE_IN,
            tx,
            { idempotencyKey: `${key}:in`, description: 'Diamonds purchased' },
          )

          return tx.diamondConversion.create({
            data: {
              userId,
              direction: DiamondConversionDirection.BUY,
              coinAmount,
              diamondAmount,
              coinLedgerEntryId: coinDebit.ledgerEntryId,
              diamondLedgerEntryId: diamondCredit.ledgerEntryId,
              idempotencyKey: key,
            },
          })
        },
        { timeout: TX_TIMEOUT_MS },
      )

    let conversion
    try {
      conversion = await withSerializationRetry(runConversion)
    } catch (err) {
      // Parallel duplicate key: winner committed between the existence check and our
      // inserts — the check now returns the original row.
      if (isUniqueViolation(err)) {
        conversion = await findExistingConversion(key)
        if (!conversion) throw err
      } else {
        throw err
      }
    }

    await walletService.adjustCoinBalanceCache(userId, 0n)
    await diamondWalletService.bustBalanceCache(userId)
    return conversion
  },

  async redeemDiamonds(userId: string, diamondAmount: bigint, idempotencyKey: string) {
    if (diamondAmount <= 0n) {
      throw new AppError(400, 'diamondAmount must be positive', 'INVALID_AMOUNT')
    }
    const key = `diamond-redeem:${userId}:${idempotencyKey}`
    const coinAmount = diamondAmount

    const runConversion = () =>
      prisma.$transaction(
        async (tx) => {
          const existing = await tx.diamondConversion.findUnique({
            where: { idempotencyKey: key },
          })
          if (existing) return existing

          const coinWallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.COIN, tx)
          const diamondWallet = await walletRepository.getOrCreate(
            userId,
            WalletCurrencyType.DIAMOND,
            tx,
          )
          await lockWalletsInOrder(tx, [coinWallet, diamondWallet])

          const diamondDebit = await diamondWalletService.debit(
            userId,
            diamondAmount,
            CoinTxType.DIAMOND_REDEEM_OUT,
            tx,
            { idempotencyKey: `${key}:out`, description: 'Diamonds redeemed' },
          )
          const coinCredit = await coinWalletService.credit(
            userId,
            coinAmount,
            CoinTxType.DIAMOND_REDEEM_IN,
            tx,
            {
              idempotencyKey: `${key}:in`,
              description: 'Diamonds redeemed',
              applyWealthCredit: false,
            },
          )

          return tx.diamondConversion.create({
            data: {
              userId,
              direction: DiamondConversionDirection.REDEEM,
              coinAmount,
              diamondAmount,
              coinLedgerEntryId: coinCredit.ledgerEntryId,
              diamondLedgerEntryId: diamondDebit.ledgerEntryId,
              idempotencyKey: key,
            },
          })
        },
        { timeout: TX_TIMEOUT_MS },
      )

    let conversion
    try {
      conversion = await withSerializationRetry(runConversion)
    } catch (err) {
      if (isUniqueViolation(err)) {
        conversion = await findExistingConversion(key)
        if (!conversion) throw err
      } else {
        throw err
      }
    }

    await diamondWalletService.bustBalanceCache(userId)
    await walletService.adjustCoinBalanceCache(userId, 0n)
    return conversion
  },
}
