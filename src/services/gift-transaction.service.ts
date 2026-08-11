import crypto, { randomUUID } from 'crypto'
import { prisma } from '../config/database'
import { hostPointsFromGift } from '../config/host-revenue-shares'
import { hostRevenueShareConfigService } from './hostRevenueShareConfig.service'
import { redisClient, RedisKeys } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { giftRepository } from '../repositories/gift.repository'
import { giftTransactionRepository } from '../repositories/gift-transaction.repository'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { walletService } from './wallet.service'
import { walletLevelService } from './user-level.service'
import { giftGalleryService } from './gift-gallery.service'
import {
  WalletCurrencyType,
  CoinTxType,
  PointTxType,
  LedgerDirection,
  LevelType,
} from '@prisma/client'
import { getPeriodKeys } from '../utils/periodKeys'
import { vipMembershipService } from './vip-membership.service'
import { fanSpendIncrementForGift } from './vip-membership.helpers'
import { utcDayFromTimestamp } from '../utils/datetime'
import { assertNotBlockedEitherWay } from '../utils/block-relationship'
import { isSerializationAbort, isUniqueViolation } from '../utils/txRetry'
import { assertCoinDebitAllowed } from './wallet-freeze.service'

const INTERACTIVE_TX_TIMEOUT_MS = 20_000
/** Serialization/deadlock aborts are expected under concurrent sends - bounded retry. */
const SEND_TX_MAX_ATTEMPTS = 3

async function invalidateAfterGiftSend(params: {
  senderId: string
  receiverId: string
  year: number
  month: number
  dayKey: string
  weekKey: string
  monthKey: string
}) {
  try {
    await redisClient.del(RedisKeys.walletCoinBalance(params.senderId))
    await redisClient.del(RedisKeys.walletPointBalance(params.receiverId))
    await redisClient.del(RedisKeys.fanRanking(params.receiverId, 'day', params.dayKey))
    await redisClient.del(RedisKeys.fanRanking(params.receiverId, 'week', params.weekKey))
    await redisClient.del(RedisKeys.fanRanking(params.receiverId, 'month', params.monthKey))
  } catch {
    // best-effort
  }
}

type SendGiftParams = {
  senderUserId: string
  receiverUserId: string
  giftId: string
  context: 'direct' | 'livestream'
  /** Number of the same catalog gift in one send. Default 1; max 100 (UI: 1/10/50/100). */
  quantity?: number
  idempotencyKey?: string
}

async function executeSendGift(params: SendGiftParams, idemBase: string) {
  if (params.senderUserId === params.receiverUserId) {
    throw new AppError(400, 'Cannot send a gift to yourself', 'INVALID_REQUEST')
  }

  const quantity = params.quantity ?? 1
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    throw new AppError(400, 'quantity must be an integer between 1 and 100', 'INVALID_REQUEST')
  }

  await assertNotBlockedEitherWay(params.senderUserId, params.receiverUserId)
  await assertCoinDebitAllowed(params.senderUserId, WalletCurrencyType.COIN)

  const gift = await giftRepository.findById(params.giftId)
  if (!gift || !gift.isActive) {
    throw new AppError(404, 'Gift not found', 'NOT_FOUND')
  }

  const senderHasActiveVipMembership = await vipMembershipService.hasActive(params.senderUserId)
  if (gift.vipOnly && !senderHasActiveVipMembership) {
    throw new AppError(403, 'VIP membership required for this gift', 'VIP_MEMBERSHIP_REQUIRED')
  }

  const unitCoinCost = gift.coinCost
  const coinCost = unitCoinCost * quantity
  const shares = await hostRevenueShareConfigService.getShares()
  const pointsAwarded = Number(hostPointsFromGift(BigInt(coinCost), shares.giftReceiveBp))
  const giftLabel = quantity > 1 ? `${gift.name} ×${quantity}` : gift.name
  const { dayKey, weekKey, monthKey, year, month } = getPeriodKeys()

  type LevelRet = Awaited<ReturnType<typeof walletLevelService.applyCredit>>

  const runSendTransaction = () =>
    prisma.$transaction(
      async (tx) => {
        const senderCoinWallet = await walletRepository.getOrCreate(
          params.senderUserId,
          WalletCurrencyType.COIN,
        )
        const receiverPointWallet = await walletRepository.getOrCreate(
          params.receiverUserId,
          WalletCurrencyType.POINT,
        )

        const ordered = [senderCoinWallet, receiverPointWallet].sort((a, b) =>
          a.id.localeCompare(b.id),
        )
        for (const w of ordered) {
          await walletRepository.lockForUpdate(tx, w.id)
        }

        const lastCoin = await tx.coinLedgerEntry.findFirst({
          where: { walletId: senderCoinWallet.id },
          orderBy: { createdAt: 'desc' },
          select: { balanceAfter: true },
        })
        const coinBal = lastCoin?.balanceAfter ?? 0n
        const cost = BigInt(coinCost)
        if (coinBal < cost) {
          throw new AppError(402, 'Insufficient coins', 'INSUFFICIENT_COINS', {
            required: cost.toString(),
            balance: coinBal.toString(),
          })
        }

        await coinLedgerRepository.insert(tx, {
          walletId: senderCoinWallet.id,
          direction: LedgerDirection.DEBIT,
          txType: CoinTxType.GIFT_SEND,
          amount: cost,
          balanceAfter: coinBal - cost,
          counterpartyId: params.receiverUserId,
          description: `Gift: ${giftLabel}`,
          metadata: {
            giftId: params.giftId,
            context: params.context,
            quantity,
            unitCoinCost,
          },
          idempotencyKey: `${idemBase}-coin`,
        })
        await walletRepository.bumpVersion(tx, senderCoinWallet.id)

        // Wealth XP tracks coin SPEND: the sender's full gift coin cost.
        const wealthResult = await walletLevelService.applyCredit(
          tx,
          params.senderUserId,
          LevelType.WEALTH,
          cost,
        )

        let livestreamResult: LevelRet | null = null
        let bustAgentUserId: string | null = null
        const giftTxRefId = pointsAwarded > 0 ? randomUUID() : null

        if (pointsAwarded > 0 && giftTxRefId) {
          const pt = BigInt(pointsAwarded)
          const lastPt = await tx.pointLedgerEntry.findFirst({
            where: { walletId: receiverPointWallet.id },
            orderBy: { createdAt: 'desc' },
            select: { balanceAfter: true },
          })
          const ptBal = lastPt?.balanceAfter ?? 0n

          const ptEntry = await pointLedgerRepository.insert(tx, {
            walletId: receiverPointWallet.id,
            direction: LedgerDirection.CREDIT,
            txType: PointTxType.GIFT_RECEIVE,
            amount: pt,
            balanceAfter: ptBal + pt,
            refId: giftTxRefId,
            counterpartyId: params.senderUserId,
            description: `Gift received: ${giftLabel}`,
            metadata: {
              giftId: params.giftId,
              giftName: gift.name,
              context: params.context,
              quantity,
              unitCoinCost,
            },
            idempotencyKey: `${idemBase}-point`,
          })
          await walletRepository.bumpVersion(tx, receiverPointWallet.id)

          // Livestream XP tracks host earnings: the gift-receive point credit.
          livestreamResult = await walletLevelService.applyCredit(
            tx,
            params.receiverUserId,
            LevelType.LIVESTREAM,
            pt,
          )

          const { agencyCommissionService } = await import('./agencyCommission.service')
          const ac = await agencyCommissionService.applyCommission(
            {
              hostUserId: params.receiverUserId,
              hostLedgerEntryId: ptEntry.id,
              hostPointsCredited: pt,
              hostTxType: PointTxType.GIFT_RECEIVE,
              day: utcDayFromTimestamp(new Date()),
            },
            tx,
          )
          bustAgentUserId = ac.bustAgentUserId

          const { rankingService } = await import('./ranking.service')
          await rankingService.onHostPointCredit(
            {
              hostUserId: params.receiverUserId,
              amount: pt,
              txType: PointTxType.GIFT_RECEIVE,
              day: utcDayFromTimestamp(new Date()),
            },
            tx,
          )
        }

        const gt = await giftTransactionRepository.create(tx, {
          id: giftTxRefId ?? undefined,
          senderUserId: params.senderUserId,
          receiverUserId: params.receiverUserId,
          giftId: params.giftId,
          coinCost,
          pointsAwarded,
          context: params.context,
          quantity,
        })

        const coinIncrement = fanSpendIncrementForGift(
          BigInt(coinCost),
          senderHasActiveVipMembership,
        )
        for (const periodType of ['day', 'week', 'month'] as const) {
          const key = periodType === 'day' ? dayKey : periodType === 'week' ? weekKey : monthKey
          await tx.fanSpend.upsert({
            where: {
              senderUserId_receiverUserId_periodType_periodKey: {
                senderUserId: params.senderUserId,
                receiverUserId: params.receiverUserId,
                periodType,
                periodKey: key,
              },
            },
            create: {
              senderUserId: params.senderUserId,
              receiverUserId: params.receiverUserId,
              periodType,
              periodKey: key,
              coinsSpent: coinIncrement,
            },
            update: {
              coinsSpent: { increment: coinIncrement },
            },
          })
        }

        return {
          transactionId: gt.id,
          wealthResult,
          livestreamResult,
          bustAgentUserId,
        }
      },
      // Default (Read Committed) isolation: correctness comes from the explicit
      // FOR UPDATE wallet locks (sender COIN, receiver POINT, and agent POINT
      // inside creditInTransaction) plus atomic ON CONFLICT increments
      // (fan_spend, agency_daily_earnings) and unique ledger/commission keys.
      // Serializable added no protection here and made every lock waiter abort
      // with 40001 when the lock holder committed (retry storms under load).
      { timeout: INTERACTIVE_TX_TIMEOUT_MS },
    )

  let txResult: Awaited<ReturnType<typeof runSendTransaction>>
  for (let attempt = 1; ; attempt++) {
    try {
      txResult = await runSendTransaction()
      break
    } catch (err) {
      if (attempt < SEND_TX_MAX_ATTEMPTS && isSerializationAbort(err)) {
        // Serialization conflict with a concurrent send - retry after brief jitter.
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)))
        continue
      }
      throw err
    }
  }

  await walletService.adjustCoinBalanceCache(params.senderUserId, 0n)
  await walletService.adjustPointBalanceCache(params.receiverUserId, 0n)

  if (txResult.wealthResult) {
    await walletLevelService.refreshCache(
      params.senderUserId,
      LevelType.WEALTH,
      txResult.wealthResult.newCumulative,
      txResult.wealthResult.newLevel,
      txResult.wealthResult.previousLevel,
    )
  }

  if (txResult.livestreamResult && pointsAwarded > 0) {
    await walletLevelService.refreshCache(
      params.receiverUserId,
      LevelType.LIVESTREAM,
      txResult.livestreamResult.newCumulative,
      txResult.livestreamResult.newLevel,
      txResult.livestreamResult.previousLevel,
    )
  }

  if (txResult.bustAgentUserId) {
    // AGENT_COMMISSION credited the agency owner inside the gift tx; drop their
    // POINT balance cache so /agency/dashboard/today `pointsBalance` is fresh.
    await walletService.adjustPointBalanceCache(txResult.bustAgentUserId, 0n)
    const { agencyCommissionService } = await import('./agencyCommission.service')
    await agencyCommissionService.afterCommissionCreditCommit(txResult.bustAgentUserId)
  }

  await invalidateAfterGiftSend({
    senderId: params.senderUserId,
    receiverId: params.receiverUserId,
    year,
    month,
    dayKey,
    weekKey,
    monthKey,
  })

  let galleryUpdated = false
  let galleryNowFull = false
  try {
    const r = await giftGalleryService.recordGiftProgress({
      hostUserId: params.receiverUserId,
      giftId: params.giftId,
      senderId: params.senderUserId,
    })
    galleryUpdated = r.created
    galleryNowFull = r.galleryNowFull
  } catch (err) {
    console.error('[Gift send] recordGiftProgress failed', err)
  }

  const senderCoinsRemaining = await walletService.getCoinBalance(params.senderUserId)

  return {
    transactionId: txResult.transactionId,
    giftName: gift.name,
    quantity,
    unitCoinCost,
    coinCost,
    pointsAwarded,
    senderCoinsRemaining: Number(senderCoinsRemaining),
    galleryUpdated,
    galleryNowFull,
  }
}

export const giftTransactionService = {
  async sendGift(params: SendGiftParams) {
    if (!params.idempotencyKey) {
      // Legacy path: per-request ledger keys, no replay window.
      return executeSendGift(params, `gift:${crypto.randomUUID()}`)
    }

    // Same envelope as withdrawal-create: Redis replay window + SET NX in-flight
    // marker; ledger idempotency keys derived from the client key so the DB
    // unique constraint backstops double-processing after the Redis TTL.
    const idem = `gift-send:${params.senderUserId}:${params.idempotencyKey}`
    const cached = await walletService.getCachedIdemResponse(idem)
    if (cached) return cached

    const acquired = await walletService.acquireIdemKey(idem)
    if (!acquired) {
      throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')
    }

    let result: Awaited<ReturnType<typeof executeSendGift>>
    try {
      result = await executeSendGift(params, `gift:${params.senderUserId}:${params.idempotencyKey}`)
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Settled earlier but the Redis snapshot expired - never double-send.
        throw new AppError(409, 'Duplicate gift send (already processed)', 'IDEM_CONFLICT')
      }
      // Definitive failure: release the in-flight marker so a corrected retry
      // with the same key is not locked out for the idem TTL.
      try {
        await redisClient.del(RedisKeys.walletIdem(idem))
      } catch {
        // best-effort
      }
      throw err
    }

    try {
      await walletService.resolveIdemKey(idem, result)
    } catch {
      // Replay window lost; the ledger unique keys still prevent double-processing.
    }
    return result
  },
}
