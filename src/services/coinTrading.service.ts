import { randomUUID } from 'crypto'
import {
  assertPositiveAmountMultiple,
  POINTS_EXCHANGE_STEP,
  TRADING_COIN_TRANSFER_STEP,
} from '../utils/transaction-amount-steps'
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
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { coinTradingRepository } from '../repositories/coinTrading.repository'
import { walletRepository } from '../repositories/wallet.repository'
import { coinLedgerRepository } from '../repositories/coin-ledger.repository'
import { pointWalletService } from './point-wallet.service'
import { coinWalletService } from './coin-wallet.service'
import { richTierService } from './rich-tier.service'
import { walletService } from './wallet.service'
import { agencyService } from './agency.service'
import { userRepository } from '../repositories/user.repository'
import { epayClient } from '../lib/epay.client'
import { prisma } from '../config/database'
import {
  PERSONAL_COIN_EXCHANGE_RATES,
  type RateTierUsd,
} from '../config/coin-trading-rates.defaults'
import { enrichLedgerEntries } from '../utils/ledger-transaction-enrichment'
import { pointLedgerRepository } from '../repositories/point-ledger.repository'
import { isUniqueViolation, withSerializationRetry } from '../utils/txRetry'

const TX_TIMEOUT_MS = 20_000

const TRADING_COIN_TX_TYPES: CoinTxType[] = [
  CoinTxType.TRADING_TOPUP,
  CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
  CoinTxType.TRADING_TRANSFER_IN,
  CoinTxType.TRADING_TRANSFER_OUT,
  CoinTxType.TRADING_TRANSFER_REVERSAL,
  CoinTxType.ADJUSTMENT,
]

async function assertAgentUser(userId: string) {
  const user = await userRepository.findById(userId)
  if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
}

function mapLedgerDirection(direction: LedgerDirection): 'credit' | 'debit' {
  return direction === LedgerDirection.CREDIT ? 'credit' : 'debit'
}

async function listEnrichedTradingTransactions(
  userId: string,
  opts: {
    direction?: 'credit' | 'debit'
    types?: CoinTxType[]
    fromDate?: Date
    toDate?: Date
    limit: number
    cursor?: string
    includeTransferFields?: boolean
    includeLegacyCounterparty?: boolean
    requireAgent?: boolean
    alwaysIncludeUserCounterparty?: boolean
  },
) {
  if (opts.fromDate && opts.toDate && opts.fromDate > opts.toDate) {
    throw new AppError(400, 'fromDate must be before or equal to toDate', 'INVALID_DATE_RANGE')
  }
  if (opts.requireAgent !== false) {
    await assertAgentUser(userId)
  }

  const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN)
  const entries = await coinLedgerRepository.list({
    walletId: wallet.id,
    types: opts.types?.length ? opts.types : TRADING_COIN_TX_TYPES,
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

  const baseEntries = page.map((e) => ({
    id: e.id,
    direction: mapLedgerDirection(e.direction),
    txType: e.txType,
    amount: e.amount,
    balanceAfter: e.balanceAfter.toString(),
    description: e.description,
    refId: e.refId,
    counterpartyId: e.counterpartyId,
    metadata: e.metadata,
    createdAt: e.createdAt,
  }))

  const enriched = await enrichLedgerEntries(baseEntries, 'TRADING_COIN', userId, {
    alwaysIncludeUserCounterparty: opts.alwaysIncludeUserCounterparty === true,
  })

  let transferByLedgerId = new Map<
    string,
    Awaited<ReturnType<typeof coinTradingRepository.findTransfersByLedgerEntryIds>>[number]
  >()
  if (opts.includeTransferFields !== false) {
    const transferRows = await coinTradingRepository.findTransfersByLedgerEntryIds(
      page.map((e) => e.id),
    )
    transferByLedgerId = new Map<string, (typeof transferRows)[number]>()
    for (const t of transferRows) {
      transferByLedgerId.set(t.senderLedgerEntryId, t)
      transferByLedgerId.set(t.recipientLedgerEntryId, t)
    }
  }

  const items = enriched.map((e) => {
    const amountStr = e.amount.toString()
    const item: Record<string, unknown> = {
      id: e.id,
      direction: e.direction,
      txType: e.txType,
      transactionName: e.transactionName,
      amount: amountStr,
      balanceAfter: e.balanceAfter,
      description: e.description,
      refId: e.refId,
      counterpartyId: e.counterpartyId,
      counterpartyDetails: e.counterpartyDetails,
      createdAt: e.createdAt.toISOString(),
    }

    if (opts.includeLegacyCounterparty) {
      const cp = e.counterpartyDetails
      item.counterparty =
        cp?.userId && cp.name && cp.publicId
          ? {
              id: cp.userId,
              name: cp.name,
              avatarUrl: cp.avatarUrl ?? null,
              publicId: cp.publicId,
            }
          : null
    }

    if (opts.includeTransferFields === false) {
      return item
    }

    const isTransferLeg =
      e.txType === CoinTxType.TRADING_TRANSFER_OUT || e.txType === CoinTxType.TRADING_TRANSFER_IN
    if (!isTransferLeg) return item

    const transfer = transferByLedgerId.get(e.id)
    if (transfer) {
      return {
        ...item,
        transferId: transfer.id,
        tradingCoinsDebited: transfer.tradingCoinsDebited.toString(),
        coinsCredited: transfer.coinsCredited.toString(),
        recipientWalletType: transfer.recipientWalletType,
      }
    }

    return {
      ...item,
      tradingCoinsDebited: amountStr,
      coinsCredited: amountStr,
    }
  })

  return { items, nextCursor }
}

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

type DbExchangeTier = {
  minUsdEquiv: Prisma.Decimal
  maxUsdEquiv: Prisma.Decimal | null
  coinsPerUsd: number
}

/**
 * Resolve `coinsPerUsd` for a USD-equivalent amount across either DB exchange-rate rows
 * (`minUsdEquiv`/`maxUsdEquiv` Decimals) or the static personal `RateTierUsd` tiers.
 */
function lookupExchangeCoinsPerUsd(
  rates: DbExchangeTier[] | RateTierUsd[],
  usdEquiv: number,
): number {
  const tier = (rates as Array<DbExchangeTier | RateTierUsd>).find((r) => {
    const min = 'minUsdEquiv' in r ? parseUsd(r.minUsdEquiv) : r.minUsd
    const rawMax = 'maxUsdEquiv' in r ? r.maxUsdEquiv : r.maxUsd
    const max =
      rawMax == null
        ? null
        : 'maxUsdEquiv' in r
          ? parseUsd(r.maxUsdEquiv as Prisma.Decimal)
          : (rawMax as number)
    return usdEquiv >= min && (max == null || usdEquiv < max)
  })
  if (!tier) throw new AppError(400, 'No rate tier', 'RATE_NOT_FOUND')
  return tier.coinsPerUsd
}

async function getPersonalExchangeRatesCached(): Promise<DbExchangeTier[]> {
  const key = RedisKeys.ctPersonalExchangeRates()
  try {
    const hit = await redisClient.get(key)
    if (hit) {
      const parsed = JSON.parse(hit) as {
        tiers: Array<{ minUsd: number; maxUsd: number | null; coinsPerUsd: number }>
      }
      return parsed.tiers.map((t) => ({
        minUsdEquiv: new Prisma.Decimal(t.minUsd),
        maxUsdEquiv: t.maxUsd == null ? null : new Prisma.Decimal(t.maxUsd),
        coinsPerUsd: t.coinsPerUsd,
      }))
    }
  } catch {
    /* miss */
  }

  const rows = await coinTradingRepository.getPersonalExchangeRates()
  if (rows.length > 0) {
    const dto = {
      tiers: rows.map((r) => ({
        minUsd: Number(r.minUsdEquiv.toString()),
        maxUsd: r.maxUsdEquiv == null ? null : Number(r.maxUsdEquiv.toString()),
        coinsPerUsd: r.coinsPerUsd,
        sortOrder: r.sortOrder,
      })),
    }
    try {
      await redisClient.set(key, JSON.stringify(dto), 'EX', CT_RATES_TTL)
    } catch {
      /* ignore */
    }
    return rows
  }

  return PERSONAL_COIN_EXCHANGE_RATES.map((t) => ({
    minUsdEquiv: new Prisma.Decimal(t.minUsd),
    maxUsdEquiv: t.maxUsd == null ? null : new Prisma.Decimal(t.maxUsd),
    coinsPerUsd: t.coinsPerUsd,
  }))
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

type TopupInitiateResult = {
  paymentUrl: string
  orderId: string
  amountUsd: string
  tradingCoinsAwarded: string
  packageId: string | null
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

  /**
   * Personal (non-agent) point→coin exchange tiers — same Prisma row shape as agent exchange rates.
   * Does not write `ct:personal-exchange-rates` (that key stores admin `{ tiers }` DTO).
   */
  async getPersonalExchangeRates() {
    const rows = await coinTradingRepository.getPersonalExchangeRates()
    if (rows.length > 0) return rows
    return PERSONAL_COIN_EXCHANGE_RATES.map((t, i) => ({
      id: `default-personal-${i}`,
      minUsdEquiv: new Prisma.Decimal(t.minUsd),
      maxUsdEquiv: t.maxUsd == null ? null : new Prisma.Decimal(t.maxUsd),
      coinsPerUsd: t.coinsPerUsd,
      sortOrder: i + 1,
      isActive: true,
      updatedAt: new Date(),
    }))
  },

  /**
   * App rates catalogue: top-up tiers (unchanged) + point-exchange tiers for the caller.
   * Agents → agent rates (TRADING_COIN). Non-agents → personal rates (COIN).
   * Response shape always `{ topupRates, exchangeRates }` (both arrays).
   */
  async getRatesForCaller(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [topupRates, exchangeRates] = await Promise.all([
      this.getTopupRates(),
      user.isAgent ? this.getExchangeRates() : this.getPersonalExchangeRates(),
    ])
    return { topupRates, exchangeRates }
  },
  /**
   * Point→coin exchange packages, with rates that depend on whether the user is an agent.
   * Agents see agent exchange rates (TRADING_COIN); non-agents see personal rates (COIN).
   * Cached per user TYPE (not per user) under `ct:exchange-packages:{agent|personal}`.
   */
  async getExchangePackages(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    const isAgent = user.isAgent

    const cacheKey = RedisKeys.ctExchangePackages(isAgent ? 'agent' : 'personal')
    const cached = await redisClient.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const rates = isAgent
      ? await coinTradingRepository.getExchangeRates()
      : await getPersonalExchangeRatesCached()

    const BASE_PACKAGES = [
      { id: 'pkg_exchange_100k', pointsRequired: 100_000n, label: '100K Points' },
      { id: 'pkg_exchange_500k', pointsRequired: 500_000n, label: '500K Points' },
    ] as const

    const result = BASE_PACKAGES.map((pkg) => {
      const usdEquiv = Number(pkg.pointsRequired) / 10_000
      const rate = lookupExchangeCoinsPerUsd(rates, usdEquiv)
      const coinsAwarded = (pkg.pointsRequired * BigInt(rate)) / 10_000n
      return {
        id: pkg.id,
        pointsRequired: pkg.pointsRequired.toString(),
        coinsAwarded: coinsAwarded.toString(),
        coinsPerUsd: rate,
        walletType: isAgent ? 'TRADING_COIN' : 'COIN',
        usdEquivalent: (Number(pkg.pointsRequired) / 10_000).toFixed(2),
        label: pkg.label,
        description: `Exchange ${Number(pkg.pointsRequired).toLocaleString()} points for ${Number(
          coinsAwarded,
        ).toLocaleString()} ${isAgent ? 'trading coins' : 'coins'}`,
      }
    })

    await redisClient.set(cacheKey, JSON.stringify(result), 'EX', 3600)
    return result
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
      idempotencyKey?: string
    },
  ) {
    const user = await userRepository.findById(agentUserId)
    if (!user?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
    await agencyService.enforcePauseGate(agentUserId)

    // Optional client key: retries replay the original order/payment link
    // instead of opening a second PENDING order + payment URL.
    const idem = input.idempotencyKey ? `ct-topup:${agentUserId}:${input.idempotencyKey}` : null
    if (idem) {
      const cached = (await walletService.getCachedIdemResponse(idem)) as TopupInitiateResult | null
      if (cached) return cached
      const acquired = await walletService.acquireIdemKey(idem)
      if (!acquired) throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')
    }
    try {
      const response: TopupInitiateResult = await coinTradingService.executeInitiateTopupInternal(
        agentUserId,
        input,
      )
      if (idem) {
        try {
          await walletService.resolveIdemKey(idem, response)
        } catch {
          // Replay window lost; the order unique key still blocks duplicates.
        }
      }
      return response
    } catch (err) {
      if (idem) {
        if (isUniqueViolation(err)) {
          throw new AppError(409, 'Duplicate top-up request (already created)', 'IDEM_CONFLICT')
        }
        try {
          await redisClient.del(RedisKeys.walletIdem(idem))
        } catch {
          // best-effort
        }
      }
      throw err
    }
  },

  async executeInitiateTopupInternal(
    agentUserId: string,
    input: {
      packageId?: string
      amountUsd?: number
      currency: string
      callbackUrl: string
      returnUrl: string
      idempotencyKey?: string
    },
  ) {
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
      const rate = await coinTradingService.lookupTopupRate(input.amountUsd)
      amountUsd = input.amountUsd
      tradingCoinsAwarded = rate.totalCoins
      rateApplied = rate.coinsPerUsd
    } else {
      throw new AppError(400, 'packageId or amountUsd required', 'TOPUP_INPUT_REQUIRED')
    }

    const idempotencyKey = input.idempotencyKey
      ? `trading-topup:${agentUserId}:${input.idempotencyKey}`
      : `trading-topup:${agentUserId}:${Date.now()}`
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
  async exchangePointsForTradingCoins(
    userId: string,
    pointsToExchange: bigint,
    clientIdempotencyKey?: string,
  ) {
    // Optional client key: retries replay the original result instead of
    // exchanging again (previously every request minted a fresh refId).
    const idem = clientIdempotencyKey ? `ct-exchange:${userId}:${clientIdempotencyKey}` : null
    if (idem) {
      const cached = (await walletService.getCachedIdemResponse(idem)) as {
        coinsAwarded: string
        walletType: string
        exchangeRate: number
      } | null
      if (cached) return cached
      const acquired = await walletService.acquireIdemKey(idem)
      if (!acquired) throw new AppError(409, 'Already processing', 'IDEM_CONFLICT')
    }
    try {
      const response = await coinTradingService.executeExchangeInternal(
        userId,
        pointsToExchange,
        clientIdempotencyKey,
      )
      if (idem) {
        try {
          await walletService.resolveIdemKey(idem, response)
        } catch {
          // Replay window lost; ledger unique keys still prevent double-processing.
        }
      }
      return response
    } catch (err) {
      if (idem) {
        if (isUniqueViolation(err)) {
          throw new AppError(409, 'Duplicate exchange (already processed)', 'IDEM_CONFLICT')
        }
        try {
          await redisClient.del(RedisKeys.walletIdem(idem))
        } catch {
          // best-effort
        }
      }
      throw err
    }
  },

  async executeExchangeInternal(
    userId: string,
    pointsToExchange: bigint,
    clientIdempotencyKey?: string,
  ) {
    assertPositiveAmountMultiple(pointsToExchange, POINTS_EXCHANGE_STEP, {
      belowMinCode: 'MIN_POINTS_EXCHANGE',
      unitLabel: 'points to exchange',
    })

    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    if (user.isAgent) {
      await agencyService.enforcePauseGate(userId)
    }

    // Determine rate tier based on user type
    const usdEquiv = Number(pointsToExchange) / 10000.0
    const rates = user.isAgent
      ? await coinTradingRepository.getExchangeRates()
      : await getPersonalExchangeRatesCached()

    const coinsPerUsd = lookupExchangeCoinsPerUsd(rates, usdEquiv)
    const coinsAwarded = BigInt(Math.floor((Number(pointsToExchange) * coinsPerUsd) / 10000))

    // Deterministic refId when the client sent a retry token, so the ledger
    // unique keys backstop double-processing after the Redis window.
    const exchangeRefId = clientIdempotencyKey
      ? `idem-${userId.slice(0, 8)}-${clientIdempotencyKey}`
      : randomUUID()
    const targetWalletType = user.isAgent
      ? WalletCurrencyType.TRADING_COIN
      : WalletCurrencyType.COIN
    const coinTxType = user.isAgent
      ? CoinTxType.TRADING_EXCHANGE_FROM_POINTS
      : CoinTxType.POINT_EXCHANGE_TO_COINS

    // Read Committed: both wallets are FOR UPDATE-locked inside debit/credit.
    // The duplicate guard prevents a post-window retry from replaying the point
    // debit while re-crediting coins.
    await withSerializationRetry(() =>
      prisma.$transaction(
        async (tx) => {
          if (clientIdempotencyKey) {
            const dup = await pointLedgerRepository.findByIdempotencyKey(
              tx,
              `exchange-pts:${exchangeRefId}`,
            )
            if (dup) {
              throw new AppError(409, 'Duplicate exchange (already processed)', 'IDEM_CONFLICT')
            }
          }
          await pointWalletService.debit(userId, pointsToExchange, PointTxType.TRANSFER_OUT, tx, {
            idempotencyKey: `exchange-pts:${exchangeRefId}`,
            refId: exchangeRefId,
            description: user.isAgent
              ? 'Points exchanged for trading coins'
              : 'Points exchanged for coins',
            metadata: { exchangeRefId },
          })

          await coinWalletService.credit(userId, coinsAwarded, coinTxType, tx, {
            idempotencyKey: user.isAgent
              ? `exchange-ct:${exchangeRefId}`
              : `exchange-coin:${exchangeRefId}`,
            description: user.isAgent
              ? 'Trading coins from points exchange'
              : 'Coins from points exchange',
            applyWealthCredit: false,
            currencyType: targetWalletType,
          })
        },
        { timeout: TX_TIMEOUT_MS },
      ),
    )

    await walletService.adjustPointBalanceCache(userId, 0n)
    if (user.isAgent) {
      await walletService.adjustTradingBalanceCache(userId)
    } else {
      await walletService.adjustCoinBalanceCache(userId, 0n)
    }

    return {
      coinsAwarded: coinsAwarded.toString(),
      walletType: user.isAgent ? 'TRADING_COIN' : 'COIN',
      exchangeRate: coinsPerUsd,
    }
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
    assertPositiveAmountMultiple(input.tradingCoins, TRADING_COIN_TRANSFER_STEP, {
      belowMinCode: 'MIN_TRANSFER',
      unitLabel: 'trading coins to transfer',
    })
    const sender = await userRepository.findById(senderAgentUserId)
    if (!sender?.isAgent) throw new AppError(403, 'Agent only', 'AGENT_ONLY')
    await agencyService.enforcePauseGate(senderAgentUserId)
    const pid = Number(input.recipientPublicId)
    const recipient = await userRepository.findByPublicId(pid)
    if (!recipient) throw new AppError(404, 'Recipient not found', 'RECIPIENT_NOT_FOUND')
    const isSelfTransfer = recipient.id === senderAgentUserId
    if (isSelfTransfer && input.targetWalletType !== 'PERSONAL') {
      throw new AppError(400, 'Self transfer only allowed to personal coin wallet', 'SELF_TRANSFER')
    }
    const recipientWalletType = resolveRecipientWalletType(recipient, input.targetWalletType)
    // Transfer into a recipient's personal COIN wallet counts as Rich tier recharge only.
    const recipientGetsPersonalCoin = recipientWalletType === WalletCurrencyType.COIN
    // Read Committed: sender + recipient wallets are FOR UPDATE-locked inside
    // debit/credit. The transfer row's unique idempotency key is the replay
    // anchor: a retry (or the loser of a parallel duplicate, via one re-run on
    // P2002) returns the original transfer row instead of moving coins twice.
    const runTransferTransaction = () =>
      prisma.$transaction(
        async (tx) => {
          const existingTransfer = await tx.coinTradingTransfer.findUnique({
            where: {
              idempotencyKey: `trading-transfer:${senderAgentUserId}:${input.idempotencyKey}`,
            },
          })
          if (existingTransfer) {
            return {
              transfer: existingTransfer,
              recharge: null as { year: number; month: number } | null,
            }
          }
          let recharge: { year: number; month: number } | null = null
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
          if (recipientGetsPersonalCoin) {
            recharge = await richTierService.applyRecharge(recipient.id, input.tradingCoins, tx)
          }
          const transferRow = await coinTradingRepository.createTransfer(
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
          return { transfer: transferRow, recharge }
        },
        { timeout: TX_TIMEOUT_MS },
      )

    let txOut: Awaited<ReturnType<typeof runTransferTransaction>>
    try {
      txOut = await withSerializationRetry(runTransferTransaction)
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Parallel duplicate key: winner committed between the existence check
        // and our inserts — re-run once; the check now returns the original row.
        txOut = await runTransferTransaction()
      } else {
        throw err
      }
    }
    const { transfer, recharge: recipientRecharge } = txOut
    await invalidateTradingTransferCaches(senderAgentUserId, recipient.id, recipientWalletType)
    if (recipientGetsPersonalCoin && recipientRecharge) {
      await richTierService.refreshCacheAfterRecharge(
        recipient.id,
        recipientRecharge.year,
        recipientRecharge.month,
      )
    }
    return transfer
  },
  async reverseTransfer(adminUserId: string, transferId: string, reason: string) {
    const transfer = await coinTradingRepository.getTransferById(transferId)
    if (!transfer) throw new AppError(404, 'Transfer not found', 'TRANSFER_NOT_FOUND')
    if (transfer.reversedAt)
      throw new AppError(409, 'Transfer already reversed', 'TRANSFER_ALREADY_REVERSED')
    const recipientWalletType = walletTypeFromTransferRecord(transfer.recipientWalletType)
    try {
      await prisma.$transaction(
        async (tx) => {
          // Debit receiver first, then credit sender (required order for safe revert).
          await coinWalletService.debit(
            transfer.recipientUserId,
            transfer.coinsCredited,
            CoinTxType.TRADING_TRANSFER_REVERSAL,
            tx,
            {
              idempotencyKey: `trading-reversal:${transfer.id}:recipient`,
              description: 'Admin fraud reversal debit',
              currencyType: recipientWalletType,
              applyWealthXp: false,
            },
          )
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
          await coinTradingRepository.reverseTransfer(
            { id: transfer.id, reversedByAdminId: adminUserId, reason },
            tx,
          )
        },
        { isolationLevel: 'Serializable', timeout: TX_TIMEOUT_MS },
      )
    } catch (err) {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_COINS') {
        if (recipientWalletType === WalletCurrencyType.TRADING_COIN) {
          throw new AppError(
            402,
            'Insufficient trading coins on receiver to revert',
            'INSUFFICIENT_TRADING_COINS',
            err.details,
          )
        }
        throw new AppError(
          402,
          'Insufficient coins on receiver to revert',
          'INSUFFICIENT_COINS',
          err.details,
        )
      }
      throw err
    }
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
  async listAllTradingTransactions(
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
    return listEnrichedTradingTransactions(userId, {
      ...opts,
      includeTransferFields: true,
      includeLegacyCounterparty: false,
    })
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
    return listEnrichedTradingTransactions(userId, {
      ...opts,
      includeTransferFields: true,
      includeLegacyCounterparty: true,
    })
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
    return listEnrichedTradingTransactions(userId, {
      ...opts,
      includeTransferFields: false,
      includeLegacyCounterparty: false,
    })
  },

  async listAdminTradingCoinHistory(
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
    return listEnrichedTradingTransactions(userId, {
      ...opts,
      includeTransferFields: true,
      includeLegacyCounterparty: false,
      requireAgent: false,
      alwaysIncludeUserCounterparty: true,
    })
  },

  async getRecentTransactionUsers(agencyUserId: string) {
    const cacheKey = RedisKeys.ctRecentUsers(agencyUserId)
    const cached = await redisClient.get(cacheKey)
    if (cached)
      return JSON.parse(cached) as Awaited<
        ReturnType<typeof coinTradingRepository.getRecentTransactionUsers>
      >
    const rows = await coinTradingRepository.getRecentTransactionUsers(agencyUserId)
    await redisClient.set(cacheKey, JSON.stringify(rows), 'EX', CT_RECENT_USERS_TTL)
    return rows
  },
}
