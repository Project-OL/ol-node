import { randomUUID } from 'crypto'
import { CoinTxType, LevelType, PointTxType, WalletCurrencyType } from '@prisma/client'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { userRepository } from '../repositories/user.repository'
import { agencyRepository } from '../repositories/agency.repository'
import { auditService } from './audit.service'
import { coinWalletService } from './coin-wallet.service'
import { pointWalletService } from './point-wallet.service'
import { richTierService } from './rich-tier.service'
import { walletLevelService } from './user-level.service'
import { walletService } from './wallet.service'

const TX_TIMEOUT_MS = 20_000

export type AdminWalletCreditResult = {
  ok: true
  userId: string
  credited: {
    coins?: string
    points?: string
    tradingCoins?: string
  }
  skipped?: {
    tradingCoins?: 'NO_AGENCY'
  }
  balances: {
    coins?: { ledgerEntryId: string; balanceAfter: string }
    points?: { ledgerEntryId: string; balanceAfter: string }
    tradingCoins?: { ledgerEntryId: string; balanceAfter: string }
  }
}

export const adminWalletService = {
  async creditUserWallets(params: {
    adminUserId: string
    targetUserId: string
    coins?: bigint
    points?: bigint
    tradingCoins?: bigint
    description?: string
    idempotencyKey?: string
  }): Promise<AdminWalletCreditResult> {
    const hasCoins = params.coins != null && params.coins > 0n
    const hasPoints = params.points != null && params.points > 0n
    const hasTrading = params.tradingCoins != null && params.tradingCoins > 0n
    if (!hasCoins && !hasPoints && !hasTrading) {
      throw new AppError(400, 'At least one positive amount is required', 'INVALID_REQUEST')
    }

    const user = await userRepository.findById(params.targetUserId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const baseKey =
      params.idempotencyKey?.trim() ||
      `admin-wallet-credit:${params.adminUserId}:${randomUUID()}`
    const description = params.description?.trim() || 'Admin wallet adjustment'
    const metadata = { adminUserId: params.adminUserId, source: 'admin_wallet_credit' }

    const credited: AdminWalletCreditResult['credited'] = {}
    const balances: AdminWalletCreditResult['balances'] = {}
    const skipped: AdminWalletCreditResult['skipped'] = {}

    if (hasPoints) {
      const points = params.points!
      const entry = (await pointWalletService.creditPoints({
        userId: params.targetUserId,
        amount: points,
        txType: PointTxType.ADJUSTMENT,
        description,
        metadata,
        idempotencyKey: `${baseKey}:points`,
      })) as { ledgerEntryId: string; balanceAfter: string }
      credited.points = points.toString()
      balances.points = {
        ledgerEntryId: entry.ledgerEntryId,
        balanceAfter: entry.balanceAfter,
      }
    }

    if (hasCoins) {
      const coins = params.coins!
      // Admin credit to a personal COIN wallet is a recharge: wealth XP + Rich tier progress.
      const { ledgerEntryId, balanceAfter, recharge } = await prisma.$transaction(
        async (tx) => {
          const credit = await coinWalletService.credit(
            params.targetUserId,
            coins,
            CoinTxType.ADJUSTMENT,
            tx,
            {
              idempotencyKey: `${baseKey}:coins`,
              description,
              metadata,
              applyWealthCredit: true,
              currencyType: WalletCurrencyType.COIN,
            },
          )
          const month = await richTierService.applyRecharge(params.targetUserId, coins, tx)
          return { ...credit, recharge: month }
        },
        { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
      )
      await walletService.adjustCoinBalanceCache(params.targetUserId, coins)
      await walletLevelService.invalidateCache(params.targetUserId, LevelType.WEALTH)
      if (recharge) {
        await richTierService.refreshCacheAfterRecharge(
          params.targetUserId,
          recharge.year,
          recharge.month,
        )
      }
      credited.coins = coins.toString()
      balances.coins = {
        ledgerEntryId,
        balanceAfter: balanceAfter.toString(),
      }
    }

    if (hasTrading) {
      const agency = await agencyRepository.getAgencyByUserId(params.targetUserId)
      if (!agency) {
        skipped.tradingCoins = 'NO_AGENCY'
      } else {
        const tradingCoins = params.tradingCoins!
        const { ledgerEntryId, balanceAfter } = await prisma.$transaction(
          async (tx) =>
            coinWalletService.credit(
              params.targetUserId,
              tradingCoins,
              CoinTxType.ADJUSTMENT,
              tx,
              {
                idempotencyKey: `${baseKey}:trading`,
                description: description || 'Admin trading coin credit',
                metadata,
                applyWealthCredit: false,
                currencyType: WalletCurrencyType.TRADING_COIN,
              },
            ),
          { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
        )
        await walletService.adjustTradingBalanceCache(params.targetUserId)
        credited.tradingCoins = tradingCoins.toString()
        balances.tradingCoins = {
          ledgerEntryId,
          balanceAfter: balanceAfter.toString(),
        }
      }
    }

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_WALLET_CREDIT',
      actionStatus: 'success',
      actionDetails: {
        targetUserId: params.targetUserId,
        credited,
        skipped: Object.keys(skipped).length > 0 ? skipped : undefined,
        description,
        idempotencyKey: baseKey,
      },
    })

    return {
      ok: true,
      userId: params.targetUserId,
      credited,
      balances,
      ...(Object.keys(skipped).length > 0 ? { skipped } : {}),
    }
  },
}
