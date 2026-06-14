import { randomUUID } from 'crypto'
import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  Prisma,
  WalletCurrencyType,
} from '@prisma/client'
import {
  redisClient,
  RedisKeys,
  CT_BALANCE_TTL,
  CT_RATES_TTL,
  CT_RECENT_USERS_TTL,
  getRedisForRead,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { coinTradingRepository } from '../repositories/coinTrading.repository'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointWalletService } from './point-wallet.service'
import { coinWalletService } from './coin-wallet.service'
import { walletService } from './wallet.service'
import { agencyService } from './agency.service'
import { userRepository } from '../repositories/user.repository'
import { epayClient } from '../lib/epay.client'
import { prisma, prismaRead } from '../config/database'

const TX_TIMEOUT_MS = 20_000

function resolveRecipientWalletType(
  recipient: { isAgent: boolean },
  targetWalletType?: 'PERSONAL' | 'TRADING',
): WalletCurrencyType {
  if (!recipient.isAgent) return WalletCurrencyType.COIN
  if (targetWalletType === 'PERSONAL') return WalletCurrencyType.COIN
  return WalletCurrencyType.TRADING_COIN
}

function walletTypeFromTransferRecord(recipientWalletType: string): WalletCurrencyType {
  return recipientWalletType === 'TRADING'
    ? WalletCurrencyType.TRADING_COIN
    : WalletCurrencyType.COIN
}

async function invalidateTradingTransferCaches(
  senderUserId: string,
  recipientUserId: string,
  recipientWalletType: WalletCurrencyType,
) {
  await walletService.adjustTradingBalanceCache(senderUserId)
  if (recipientWalletType === WalletCurrencyType.COIN) {
    await walletService.adjustCoinBalanceCache(recipientUserId, 0n)
  } else {
    await walletService.adjustTradingBalanceCache(recipientUserId)
  }
  await redisClient.del(RedisKeys.ctRecentUsers(senderUserId))
}

function parseUsd(v: Prisma.Decimal): number {
  return Number(v.toString())
}

function formatPackage(row: {
  id: string
  tradingCoins: bigint
  priceCents: number
  coinsPerUsd: number
  currency: string
  label: string | null
}) {
  return {
    id: row.id,
    tradingCoins: row.tradingCoins.toString(),
    priceCents: row.priceCents,
    amountUsd: (row.priceCents / 100).toFixed(2),
    coinsPerUsd: row.coinsPerUsd,
    currency: row.currency,
    label: row.label,
  }
}

export const coinTradingService = {
  async getTopupPackages() {
    const key = RedisKeys.ctTopupPackages()
    const cached = await redisClient.get(key)
    if (cached) return JSON.parse(cached)
    const rows = await coinTradingRepository.getTopupPackages()
    const packages = rows.map(formatPackage)
    await redisClient.set(key, JSON.stringify(packages), 'EX', CT_RATES_TTL)
    return packages
  },
  async getTopupRates() {
    const key = RedisKeys.ctTopupRates()
    const cached = await redisClient.get(key)
    if (cached) return JSON.parse(cached)
    const rows = await coinTradingRepository.getTopupRates()
    await redisClient.set(key, JSON.stringify(rows), 'EX', CT_RATES_TTL)
    return rows
  },
  async getExchangeRates() {
    const key = RedisKeys.ctExchangeRates()
    const cached = await redisClient.get(key)
    if (cached) return JSON.parse(cached)
    const rows = await coinTradingRepository.getExchangeRates()
    await redisClient.set(key, JSON.stringify(rows), 'EX', CT_RATES_TTL)
    return rows
  },
  async lookupTopupRate(amountUsd: number) {
    const rates = await coinTradingRepository.getTopupRates()
    const tier = rates.find(
      (r) =>
        amountUsd >= parseUsd(r.minUsd) && (r.maxUsd == null || amountUsd < parseUsd(r.maxUsd)),
    )
    if (!tier) throw new AppError(400, 'No rate tier', 'RATE_NOT_FOUND')
    const totalCoins = BigInt(Math.floor(amountUsd * tier.coinsPerUsd))
    return { coinsPerUsd: tier.coinsPerUsd, totalCoins }
  },
  async lookupExchangeRate(pointsToExchange: bigint) {
    const usdEquiv = Number(pointsToExchange) / 10000.0
    const rates = await coinTradingRepository.getExchangeRates()
    const tier = rates.find(
      (r) =>
        usdEquiv >= parseUsd(r.minUsdEquiv) &&
        (r.maxUsdEquiv == null || usdEquiv < parseUsd(r.maxUsdEquiv)),
    )
    if (!tier) throw new AppError(400, 'No rate tier', 'RATE_NOT_FOUND')
    const tradingCoinsAwarded = BigInt(
      Math.floor((Number(pointsToExchange) * tier.coinsPerUsd) / 10000),
    )
    return { usdEquiv, coinsPerUsd: tier.coinsPerUsd, tradingCoinsAwarded }
  },
  async initiateTopup(
    agentUserId: string,
    input: {
      packageId?: string
      amountUsd?: number
      currency: string
      callbackUrl: string
      returnUrl: string
    },
  ) {
    const user = await userRepository.findById(agentUserId)
    if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
    await agencyService.enforcePauseGate(agentUserId)

    let amountUsd: number
    let tradingCoinsAwarded: bigint
    let rateApplied: number
    let packageId: string | undefined

    if (input.packageId) {
      const pkg = await coinTradingRepository.getTopupPackageById(input.packageId)
      if (!pkg) throw new AppError(404, 'Package not found', 'PACKAGE_NOT_FOUND')
      packageId = pkg.id
      amountUsd = pkg.priceCents / 100
      tradingCoinsAwarded = pkg.tradingCoins
      rateApplied = pkg.coinsPerUsd
    } else if (input.amountUsd != null) {
      const rate = await this.lookupTopupRate(input.amountUsd)
      amountUsd = input.amountUsd
      tradingCoinsAwarded = rate.totalCoins
      rateApplied = rate.coinsPerUsd
    } else {
      throw new AppError(400, 'packageId or amountUsd required', 'TOPUP_INPUT_REQUIRED')
    }

    const idempotencyKey = `trading-topup:${agentUserId}:${Date.now()}`
    const order = await prisma.coinTradingTopupOrder.create({
      data: {
        agentUserId,
        packageId,
        amountUsd: new Prisma.Decimal(amountUsd.toFixed(2)),
        tradingCoinsAwarded,
        rateApplied,
        idempotencyKey,
        status: 'PENDING',
      },
    })
    const epay = await epayClient.createOrder({
      amountUsd,
      currency: input.currency,
      orderId: order.id,
      orderType: 'TRADING_TOPUP',
      description: 'Trading coin top-up',
      callbackUrl: input.callbackUrl,
      returnUrl: input.returnUrl,
    })
    await prisma.coinTradingTopupOrder.update({
      where: { id: order.id },
      data: { epayRef: epay.gatewayRef },
    })
    return {
      paymentUrl: epay.paymentUrl,
      orderId: order.id,
      amountUsd: amountUsd.toFixed(2),
      tradingCoinsAwarded: tradingCoinsAwarded.toString(),
      packageId: packageId ?? null,
    }
  },
  async confirmTopup(
    order: {
      id: string
      agentUserId: string
      amountUsd: Prisma.Decimal
      tradingCoinsAwarded: bigint
      status: string
    },
    payload: { gatewayRef: string; amountUsd: number },
  ) {
    await prisma.$transaction(
      async (tx) => {
        const fresh = await tx.coinTradingTopupOrder.findUnique({ where: { id: order.id } })
        if (!fresh || fresh.status !== 'PENDING') return
        if (Number(fresh.amountUsd.toString()) !== payload.amountUsd) {
          throw new AppError(400, 'Webhook amount mismatch', 'TOPUP_AMOUNT_MISMATCH')
        }
        const wallet = await walletRepository.getOrCreate(
          fresh.agentUserId,
          WalletCurrencyType.TRADING_COIN,
        )
        await walletRepository.lockForUpdate(tx, wallet.id)
        const last = await tx.coinLedgerEntry.findFirst({
          where: { walletId: wallet.id },
          orderBy: { createdAt: 'desc' },
          select: { balanceAfter: true },
        })
        const balance = last?.balanceAfter ?? 0n
        const entry = await coinLedgerRepository.insert(tx, {
          walletId: wallet.id,
          direction: LedgerDirection.CREDIT,
          txType: CoinTxType.TRADING_TOPUP,
          amount: fresh.tradingCoinsAwarded,
          balanceAfter: balance + fresh.tradingCoinsAwarded,
          refId: payload.gatewayRef,
          description: 'Trading coin top-up',
          idempotencyKey: `trading-topup:${fresh.id}`,
        })
        await tx.coinTradingTopupOrder.update({
          where: { id: fresh.id },
          data: { status: 'COMPLETED', ledgerEntryId: entry.id },
        })
      },
      { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
    )
    await walletService.adjustTradingBalanceCache(order.agentUserId)
  },
  async exchangePointsForTradingCoins(agentUserId: string, pointsToExchange: bigint) {
    if (pointsToExchange < 10_000n)
      throw new AppError(400, 'Minimum 10,000 points', 'MIN_POINTS_EXCHANGE')
    const user = await userRepository.findById(agentUserId)
    if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
    await agencyService.enforcePauseGate(agentUserId)
    const rate = await this.lookupExchangeRate(pointsToExchange)
    const exchangeRefId = randomUUID()
    await prisma.$transaction(
      async (tx) => {
        await pointWalletService.debit(
          agentUserId,
          pointsToExchange,
          PointTxType.TRANSFER_OUT,
          tx,
          {
            idempotencyKey: `exchange-pts:${exchangeRefId}`,
            refId: exchangeRefId,
            description: 'Points exchanged for trading coins',
            metadata: { exchangeRefId },
          },
        )
        await coinWalletService.credit(
          agentUserId,
          rate.tradingCoinsAwarded,
          CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
          tx,
          {
            idempotencyKey: `exchange-ct:${exchangeRefId}`,
            description: 'Trading coins from points exchange',
            applyWealthCredit: false,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        )
      },
      { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
    )
    await walletService.adjustPointBalanceCache(agentUserId, 0n)
    await walletService.adjustTradingBalanceCache(agentUserId)
    return { tradingCoinsAwarded: rate.tradingCoinsAwarded.toString() }
  },
  async transferTradingCoins(
    senderAgentUserId: string,
    input: {
      recipientPublicId: string
      tradingCoins: bigint
      targetWalletType?: 'PERSONAL' | 'TRADING'
      idempotencyKey: string
    },
  ) {
    if (input.tradingCoins < 100n)
      throw new AppError(400, 'Minimum transfer is 100', 'MIN_TRANSFER')
    const sender = await userRepository.findById(senderAgentUserId)
    if (!sender?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
    await agencyService.enforcePauseGate(senderAgentUserId)
    const pid = Number(input.recipientPublicId)
    const recipient = await userRepository.findByPublicId(pid)
    if (!recipient) throw new AppError(404, 'Recipient not found', 'RECIPIENT_NOT_FOUND')
    if (recipient.id === senderAgentUserId)
      throw new AppError(400, 'Self transfer blocked', 'SELF_TRANSFER')
    const recipientWalletType = resolveRecipientWalletType(recipient, input.targetWalletType)
    const transfer = await prisma.$transaction(
      async (tx) => {
        const senderDebit = await coinWalletService.debit(
          senderAgentUserId,
          input.tradingCoins,
          CoinTxType.TRADING_TRANSFER_OUT,
          tx,
          {
            idempotencyKey: `trading-transfer:${senderAgentUserId}:${input.idempotencyKey}:out`,
            description: 'Trading coin transfer out',
            counterpartyId: recipient.id,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        )
        const recipientCredit = await coinWalletService.credit(
          recipient.id,
          input.tradingCoins,
          CoinTxType.TRADING_TRANSFER_IN,
          tx,
          {
            idempotencyKey: `trading-transfer:${senderAgentUserId}:${input.idempotencyKey}:in`,
            description: 'Trading coin transfer in',
            counterpartyId: senderAgentUserId,
            applyWealthCredit: false,
            currencyType: recipientWalletType,
          },
        )
        return coinTradingRepository.createTransfer(
          {
            senderAgentUserId,
            recipientUserId: recipient.id,
            tradingCoinsDebited: input.tradingCoins,
            coinsCredited: input.tradingCoins,
            recipientWalletType:
              recipientWalletType === WalletCurrencyType.COIN ? 'PERSONAL' : 'TRADING',
            senderLedgerEntryId: senderDebit.ledgerEntryId,
            recipientLedgerEntryId: recipientCredit.ledgerEntryId,
            idempotencyKey: `trading-transfer:${senderAgentUserId}:${input.idempotencyKey}`,
          },
          tx,
        )
      },
      { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
    )
    await invalidateTradingTransferCaches(senderAgentUserId, recipient.id, recipientWalletType)
    return transfer
  },
  async reverseTransfer(adminUserId: string, transferId: string, reason: string) {
    const transfer = await coinTradingRepository.getTransferById(transferId)
    if (!transfer) throw new AppError(404, 'Transfer not found', 'TRANSFER_NOT_FOUND')
    if (transfer.reversedAt)
      throw new AppError(409, 'Transfer already reversed', 'TRANSFER_ALREADY_REVERSED')
    const recipientWalletType = walletTypeFromTransferRecord(transfer.recipientWalletType)
    await prisma.$transaction(
      async (tx) => {
        await coinWalletService.credit(
          transfer.senderAgentUserId,
          transfer.tradingCoinsDebited,
          CoinTxType.TRADING_TRANSFER_REVERSAL,
          tx,
          {
            idempotencyKey: `trading-reversal:${transfer.id}:sender`,
            description: 'Admin fraud reversal credit',
            applyWealthCredit: false,
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        )
        await coinWalletService.debit(
          transfer.recipientUserId,
          transfer.coinsCredited,
          CoinTxType.TRADING_TRANSFER_REVERSAL,
          tx,
          {
            idempotencyKey: `trading-reversal:${transfer.id}:recipient`,
            description: 'Admin fraud reversal debit',
            currencyType: recipientWalletType,
          },
        )
        await coinTradingRepository.reverseTransfer(
          { id: transfer.id, reversedByUserId: adminUserId, reason },
          tx,
        )
      },
      { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
    )
    await invalidateTradingTransferCaches(
      transfer.senderAgentUserId,
      transfer.recipientUserId,
      recipientWalletType,
    )
  },
  async getTradingBalance(agentUserId: string) {
    const key = RedisKeys.ctBalance(agentUserId)
    const cached = await redisClient.get(key)
    if (cached != null) return BigInt(cached)
    const balance = await coinTradingRepository.getTradingBalance(agentUserId)
    await redisClient.set(key, balance.toString(), 'EX', CT_BALANCE_TTL)
    return balance
  },
  async listTopupHistory(agentUserId: string, opts: { limit: number; cursor?: string }) {
    const rows = await coinTradingRepository.listTopupOrders(agentUserId, opts)
    const ledgerIds = [
      ...new Set(rows.map((row) => row.ledgerEntryId).filter((id): id is string => id != null)),
    ]
    const ledgerBalances = new Map(
      (await coinTradingRepository.listLedgerBalancesByIds(ledgerIds)).map((entry) => [
        entry.id,
        entry.balanceAfter,
      ]),
    )
    return rows.map((row) => ({
      ...row,
      balanceAfter: row.ledgerEntryId
        ? (ledgerBalances.get(row.ledgerEntryId)?.toString() ?? null)
        : null,
    }))
  },
  async listTransferHistory(
    userId: string,
    opts: {
      direction?: 'credit' | 'debit'
      fromDate?: Date
      toDate?: Date
      limit: number
      cursor?: string
    },
  ) {
    if (opts.fromDate && opts.toDate && opts.fromDate > opts.toDate) {
      throw new AppError(400, 'fromDate must be before or equal to toDate', 'INVALID_DATE_RANGE')
    }
    const user = await userRepository.findById(userId)
    if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')

    const tradingTxTypes: CoinTxType[] = [
      CoinTxType.TRADING_TOPUP,
      CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
      CoinTxType.TRADING_TRANSFER_IN,
      CoinTxType.TRADING_TRANSFER_OUT,
      CoinTxType.TRADING_TRANSFER_REVERSAL,
      CoinTxType.ADJUSTMENT,
    ]

    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN)
    const entries = await coinLedgerRepository.list({
      walletId: wallet.id,
      types: tradingTxTypes,
      direction:
        opts.direction === 'credit'
          ? LedgerDirection.CREDIT
          : opts.direction === 'debit'
            ? LedgerDirection.DEBIT
            : undefined,
      from: opts.fromDate,
      to: opts.toDate,
      cursor: opts.cursor,
      limit: opts.limit,
    })

    const hasMore = entries.length > opts.limit
    const page = hasMore ? entries.slice(0, opts.limit) : entries
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null

    const counterpartyIds = [
      ...new Set(page.map((e) => e.counterpartyId).filter((id): id is string => id != null)),
    ]
    const counterpartyUsers =
      counterpartyIds.length > 0
        ? await prismaRead.user.findMany({
            where: { id: { in: counterpartyIds } },
            select: {
              id: true,
              username: true,
              avatarUrl: true,
              publicId: true,
            },
          })
        : []
    const counterpartyMap = new Map(counterpartyUsers.map((u) => [u.id, u]))

    const ledgerIds = page.map((e) => e.id)
    const transferRows = await coinTradingRepository.findTransfersByLedgerEntryIds(ledgerIds)
    const transferByLedgerId = new Map<string, (typeof transferRows)[number]>()
    for (const t of transferRows) {
      transferByLedgerId.set(t.senderLedgerEntryId, t)
      transferByLedgerId.set(t.recipientLedgerEntryId, t)
    }

    const items = page.map((e) => {
      const cp = e.counterpartyId ? counterpartyMap.get(e.counterpartyId) : null
      const isDebit = e.direction === LedgerDirection.DEBIT
      const amountStr = e.amount.toString()
      const base = {
        id: e.id,
        direction: isDebit ? ('debit' as const) : ('credit' as const),
        txType: e.txType,
        amount: amountStr,
        balanceAfter: e.balanceAfter.toString(),
        description: e.description,
        refId: e.refId,
        createdAt: e.createdAt.toISOString(),
        counterparty: cp
          ? {
              id: cp.id,
              name: cp.username,
              avatarUrl: cp.avatarUrl,
              publicId: cp.publicId.toString(),
            }
          : null,
      }

      const isTransferLeg =
        e.txType === CoinTxType.TRADING_TRANSFER_OUT ||
        e.txType === CoinTxType.TRADING_TRANSFER_IN
      if (!isTransferLeg) return base

      const transfer = transferByLedgerId.get(e.id)
      if (transfer) {
        return {
          ...base,
          transferId: transfer.id,
          tradingCoinsDebited: transfer.tradingCoinsDebited.toString(),
          coinsCredited: transfer.coinsCredited.toString(),
          recipientWalletType: transfer.recipientWalletType,
        }
      }

      return {
        ...base,
        tradingCoinsDebited: amountStr,
        coinsCredited: amountStr,
      }
    })

    return { items, nextCursor }
  },

  async listTradingCoinHistory(
    userId: string,
    opts: {
      direction?: 'credit' | 'debit'
      types?: CoinTxType[]
      fromDate?: Date
      toDate?: Date
      limit: number
      cursor?: string
    },
  ) {
    if (opts.fromDate && opts.toDate && opts.fromDate > opts.toDate) {
      throw new AppError(400, 'fromDate must be before or equal to toDate', 'INVALID_DATE_RANGE')
    }
    const user = await userRepository.findById(userId)
    if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')

    const defaultTypes: CoinTxType[] = [
      CoinTxType.TRADING_TOPUP,
      CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
      CoinTxType.TRADING_TRANSFER_IN,
      CoinTxType.TRADING_TRANSFER_OUT,
      CoinTxType.TRADING_TRANSFER_REVERSAL,
      CoinTxType.ADJUSTMENT,
    ]

    const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN)
    const entries = await coinLedgerRepository.list({
      walletId: wallet.id,
      types: opts.types?.length ? opts.types : defaultTypes,
      direction:
        opts.direction === 'credit'
          ? LedgerDirection.CREDIT
          : opts.direction === 'debit'
            ? LedgerDirection.DEBIT
            : undefined,
      from: opts.fromDate,
      to: opts.toDate,
      cursor: opts.cursor,
      limit: opts.limit,
    })

    const hasMore = entries.length > opts.limit
    const page = hasMore ? entries.slice(0, opts.limit) : entries
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1]!.id : null

    return {
      items: page.map((e) => ({
        id: e.id,
        direction: e.direction === LedgerDirection.CREDIT ? ('credit' as const) : ('debit' as const),
        txType: e.txType,
        amount: e.amount.toString(),
        balanceAfter: e.balanceAfter.toString(),
        description: e.description,
        refId: e.refId,
        counterpartyId: e.counterpartyId,
        createdAt: e.createdAt.toISOString(),
      })),
      nextCursor,
    }
  },

  async getRecentTransactionUsers(agencyUserId: string) {
    const redis = getRedisForRead()
    const cacheKey = RedisKeys.ctRecentUsers(agencyUserId)
    const cached = await redis.get(cacheKey)
    if (cached)
      return JSON.parse(cached) as Awaited<
        ReturnType<typeof coinTradingRepository.getRecentTransactionUsers>
      >
    const rows = await coinTradingRepository.getRecentTransactionUsers(agencyUserId)
    await redisClient.set(cacheKey, JSON.stringify(rows), 'EX', CT_RECENT_USERS_TTL)
    return rows
  },
}
