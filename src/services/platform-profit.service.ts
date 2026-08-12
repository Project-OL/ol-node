import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  Prisma,
  WithdrawalStatus,
} from '@prisma/client'
import { prismaRead } from '../config/database'
import { rootLogger } from '../utils/rootLogger'
import {
  profitFromCoinToPointSplit,
  profitFromFullCoinSink,
  profitFromWithdrawalFee,
  sumPlatformProfit,
  wouldBeNegative,
  ZERO_PLATFORM_PROFIT,
  type PlatformProfitBuckets,
} from '../utils/platform-profit'

const log = rootLogger.child({ module: 'platform-profit' })

export type { PlatformProfitBuckets }

const FULL_COIN_SINK_TX = new Set<CoinTxType>([
  CoinTxType.STORE_ITEM_PURCHASE,
  CoinTxType.VIP_PURCHASE,
  CoinTxType.VIP_MEMBERSHIP_PURCHASE,
  CoinTxType.USERNAME_CHANGE,
])

const COIN_TO_POINT_SPEND_TX = new Set<CoinTxType>([
  CoinTxType.GIFT_SEND,
  CoinTxType.VIDEO_CALL,
  CoinTxType.CREATOR_SUBSCRIPTION,
  CoinTxType.GUARDIAN_PURCHASE,
])

function warnIfNegative(raw: bigint, context: Record<string, unknown>) {
  if (wouldBeNegative(raw)) {
    log.warn({ ...context, raw: raw.toString() }, 'platform profit raw negative; clamped to 0')
  }
}

/**
 * Sum AGENT_COMMISSION credits grouped by refId (gift id, session id, subscription id, …).
 */
export async function sumAgencyCommissionByRefIds(
  refIds: string[],
): Promise<Map<string, bigint>> {
  const unique = [...new Set(refIds.filter(Boolean))]
  const map = new Map<string, bigint>()
  if (unique.length === 0) return map

  const rows = await prismaRead.pointLedgerEntry.groupBy({
    by: ['refId'],
    where: {
      txType: PointTxType.AGENT_COMMISSION,
      direction: LedgerDirection.CREDIT,
      refId: { in: unique },
    },
    _sum: { amount: true },
  })
  for (const r of rows) {
    if (r.refId) map.set(r.refId, r._sum.amount ?? 0n)
  }
  return map
}

/**
 * Sum host point credits (GIFT_RECEIVE / VIDEO_CALL / SUBSCRIPTION / GUARDIAN) by refId.
 */
export async function sumHostPointsByRefIds(
  refIds: string[],
  txTypes: PointTxType[],
): Promise<Map<string, bigint>> {
  const unique = [...new Set(refIds.filter(Boolean))]
  const map = new Map<string, bigint>()
  if (unique.length === 0) return map

  const rows = await prismaRead.pointLedgerEntry.groupBy({
    by: ['refId'],
    where: {
      txType: { in: txTypes },
      direction: LedgerDirection.CREDIT,
      refId: { in: unique },
    },
    _sum: { amount: true },
  })
  for (const r of rows) {
    if (r.refId) map.set(r.refId, r._sum.amount ?? 0n)
  }
  return map
}

export function profitForGiftRow(params: {
  coinCost: number | bigint
  pointsAwarded: number | bigint
  agencyCommissionPoints: bigint
}): PlatformProfitBuckets {
  const { buckets, rawCoins } = profitFromCoinToPointSplit({
    coinsSpent: BigInt(params.coinCost),
    hostPoints: BigInt(params.pointsAwarded),
    agencyCommissionPoints: params.agencyCommissionPoints,
  })
  warnIfNegative(rawCoins, {
    kind: 'gift',
    coinCost: String(params.coinCost),
    pointsAwarded: String(params.pointsAwarded),
    agency: params.agencyCommissionPoints.toString(),
  })
  return buckets
}

export function profitForFullCoinSpend(amount: bigint): PlatformProfitBuckets {
  return profitFromFullCoinSink(amount)
}

export function profitForWithdrawalRow(params: {
  platformFeePoints: bigint | null | undefined
  agentRewardPoints: bigint | null | undefined
}): PlatformProfitBuckets {
  const fee = params.platformFeePoints ?? 0n
  const agent = params.agentRewardPoints ?? 0n
  const { buckets, rawPoints } = profitFromWithdrawalFee({
    platformFeePoints: fee,
    agentRewardPoints: agent,
  })
  warnIfNegative(rawPoints, {
    kind: 'withdrawal',
    fee: fee.toString(),
    agent: agent.toString(),
  })
  return buckets
}

/**
 * Derive profit for a personal-COIN debit ledger row (spend side only).
 */
export function profitForCoinDebitRow(params: {
  txType: CoinTxType
  amount: bigint
  /** Resolved gift snapshot when txType is GIFT_SEND */
  gift?: { coinCost: number; pointsAwarded: number; id: string } | null
  agencyByRefId: Map<string, bigint>
  hostPointsByRefId: Map<string, bigint>
  refId: string | null
}): PlatformProfitBuckets {
  if (FULL_COIN_SINK_TX.has(params.txType)) {
    return profitForFullCoinSpend(params.amount)
  }

  if (params.txType === CoinTxType.GIFT_SEND) {
    if (!params.gift) return ZERO_PLATFORM_PROFIT
    const agency = params.agencyByRefId.get(params.gift.id) ?? 0n
    return profitForGiftRow({
      coinCost: params.gift.coinCost,
      pointsAwarded: params.gift.pointsAwarded,
      agencyCommissionPoints: agency,
    })
  }

  if (COIN_TO_POINT_SPEND_TX.has(params.txType) && params.refId) {
    const hostPoints = params.hostPointsByRefId.get(params.refId) ?? 0n
    const agency = params.agencyByRefId.get(params.refId) ?? 0n
    const { buckets, rawCoins } = profitFromCoinToPointSplit({
      coinsSpent: params.amount,
      hostPoints,
      agencyCommissionPoints: agency,
    })
    warnIfNegative(rawCoins, {
      kind: params.txType,
      refId: params.refId,
      amount: params.amount.toString(),
      hostPoints: hostPoints.toString(),
      agency: agency.toString(),
    })
    return buckets
  }

  return ZERO_PLATFORM_PROFIT
}

function dateFilter(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  }
}

/**
 * Platform-wide profit totals for a date window (Phase 1 live aggregates).
 */
export async function summarizePlatformProfit(params: {
  from?: Date
  to?: Date
}): Promise<PlatformProfitBuckets> {
  const createdAt = dateFilter(params.from, params.to)
  const parts: PlatformProfitBuckets[] = []

  // Gifts: sum(coinCost − pointsAwarded) − AGENT_COMMISSION (hostTxType GIFT_RECEIVE)
  const giftAgg = await prismaRead.giftTransaction.aggregate({
    where: createdAt ? { createdAt } : undefined,
    _sum: { coinCost: true, pointsAwarded: true },
  })
  const giftAgencyAgg = await prismaRead.pointLedgerEntry.aggregate({
    where: {
      direction: LedgerDirection.CREDIT,
      txType: PointTxType.AGENT_COMMISSION,
      ...(createdAt ? { createdAt } : {}),
      metadata: { path: ['hostTxType'], equals: PointTxType.GIFT_RECEIVE },
    },
    _sum: { amount: true },
  })
  {
    const { buckets, rawCoins } = profitFromCoinToPointSplit({
      coinsSpent: BigInt(giftAgg._sum.coinCost ?? 0),
      hostPoints: BigInt(giftAgg._sum.pointsAwarded ?? 0),
      agencyCommissionPoints: giftAgencyAgg._sum.amount ?? 0n,
    })
    warnIfNegative(rawCoins, { kind: 'summary_gifts' })
    parts.push(buckets)
  }

  // Store purchases
  const storeAgg = await prismaRead.userStoreItem.aggregate({
    where: createdAt ? { createdAt } : undefined,
    _sum: { coinsPaid: true },
  })
  parts.push(profitForFullCoinSpend(BigInt(storeAgg._sum.coinsPaid ?? 0)))

  // VIP membership
  const vipAgg = await prismaRead.vipMembershipPurchase.aggregate({
    where: createdAt ? { createdAt } : undefined,
    _sum: { coinCost: true },
  })
  parts.push(profitForFullCoinSpend(vipAgg._sum.coinCost ?? 0n))

  // Full coin sinks from ledger (rare ID VIP_PURCHASE + username) — VIP membership already counted via table
  const sinkAgg = await prismaRead.coinLedgerEntry.aggregate({
    where: {
      direction: LedgerDirection.DEBIT,
      txType: { in: [CoinTxType.VIP_PURCHASE, CoinTxType.USERNAME_CHANGE] },
      ...(createdAt ? { createdAt } : {}),
      wallet: { currencyType: 'COIN' },
    },
    _sum: { amount: true },
  })
  parts.push(profitForFullCoinSpend(sinkAgg._sum.amount ?? 0n))

  // Video call / subscription / guardian: coin debits − host point credits − agency (same window)
  for (const { coinType, pointType } of [
    { coinType: CoinTxType.VIDEO_CALL, pointType: PointTxType.VIDEO_CALL },
    { coinType: CoinTxType.CREATOR_SUBSCRIPTION, pointType: PointTxType.SUBSCRIPTION },
    { coinType: CoinTxType.GUARDIAN_PURCHASE, pointType: PointTxType.GUARDIAN_PURCHASE },
  ] as const) {
    const coinSum = await prismaRead.coinLedgerEntry.aggregate({
      where: {
        direction: LedgerDirection.DEBIT,
        txType: coinType,
        ...(createdAt ? { createdAt } : {}),
        wallet: { currencyType: 'COIN' },
      },
      _sum: { amount: true },
    })
    const hostSum = await prismaRead.pointLedgerEntry.aggregate({
      where: {
        direction: LedgerDirection.CREDIT,
        txType: pointType,
        ...(createdAt ? { createdAt } : {}),
      },
      _sum: { amount: true },
    })
    const agencySum = await prismaRead.pointLedgerEntry.aggregate({
      where: {
        direction: LedgerDirection.CREDIT,
        txType: PointTxType.AGENT_COMMISSION,
        ...(createdAt ? { createdAt } : {}),
        metadata: {
          path: ['hostTxType'],
          equals: pointType,
        },
      },
      _sum: { amount: true },
    })
    const { buckets, rawCoins } = profitFromCoinToPointSplit({
      coinsSpent: coinSum._sum.amount ?? 0n,
      hostPoints: hostSum._sum.amount ?? 0n,
      agencyCommissionPoints: agencySum._sum.amount ?? 0n,
    })
    warnIfNegative(rawCoins, { kind: `summary_${coinType}` })
    parts.push(buckets)
  }

  // Withdrawals: net fee on rows that have fee snapshot (typically settled)
  const withdrawals = await prismaRead.withdrawal.findMany({
    where: {
      platformFeePoints: { not: null },
      status: { in: [WithdrawalStatus.PAID, WithdrawalStatus.WAITING] },
      ...(createdAt
        ? {
            OR: [
              { processedAt: createdAt },
              { processedAt: null, requestedAt: createdAt },
            ],
          }
        : {}),
    },
    select: { platformFeePoints: true, agentRewardPoints: true },
  })
  let wPoints = 0n
  for (const w of withdrawals) {
    const { buckets, rawPoints } = profitFromWithdrawalFee({
      platformFeePoints: w.platformFeePoints ?? 0n,
      agentRewardPoints: w.agentRewardPoints ?? 0n,
    })
    warnIfNegative(rawPoints, { kind: 'summary_withdrawal' })
    wPoints += BigInt(buckets.points)
  }
  parts.push({ coins: '0', points: wPoints.toString(), tradingCoins: '0' })

  return sumPlatformProfit(parts)
}

/**
 * Admin ADJUSTMENT created (credit) vs returned (debit) supply totals.
 */
export async function summarizeAdminCurrencySupply(params: {
  from?: Date
  to?: Date
}): Promise<{
  created: PlatformProfitBuckets
  returned: PlatformProfitBuckets
}> {
  const createdAt = dateFilter(params.from, params.to)

  const [coinCredit, coinDebit, tradingCredit, tradingDebit, pointCredit, pointDebit] =
    await Promise.all([
      prismaRead.coinLedgerEntry.aggregate({
        where: {
          txType: CoinTxType.ADJUSTMENT,
          direction: LedgerDirection.CREDIT,
          wallet: { currencyType: 'COIN' },
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
      prismaRead.coinLedgerEntry.aggregate({
        where: {
          txType: CoinTxType.ADJUSTMENT,
          direction: LedgerDirection.DEBIT,
          wallet: { currencyType: 'COIN' },
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
      prismaRead.coinLedgerEntry.aggregate({
        where: {
          txType: CoinTxType.ADJUSTMENT,
          direction: LedgerDirection.CREDIT,
          wallet: { currencyType: 'TRADING_COIN' },
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
      prismaRead.coinLedgerEntry.aggregate({
        where: {
          txType: CoinTxType.ADJUSTMENT,
          direction: LedgerDirection.DEBIT,
          wallet: { currencyType: 'TRADING_COIN' },
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
      prismaRead.pointLedgerEntry.aggregate({
        where: {
          txType: PointTxType.ADJUSTMENT,
          direction: LedgerDirection.CREDIT,
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
      prismaRead.pointLedgerEntry.aggregate({
        where: {
          txType: PointTxType.ADJUSTMENT,
          direction: LedgerDirection.DEBIT,
          ...(createdAt ? { createdAt } : {}),
        },
        _sum: { amount: true },
      }),
    ])

  return {
    created: {
      coins: (coinCredit._sum.amount ?? 0n).toString(),
      points: (pointCredit._sum.amount ?? 0n).toString(),
      tradingCoins: (tradingCredit._sum.amount ?? 0n).toString(),
    },
    returned: {
      coins: (coinDebit._sum.amount ?? 0n).toString(),
      points: (pointDebit._sum.amount ?? 0n).toString(),
      tradingCoins: (tradingDebit._sum.amount ?? 0n).toString(),
    },
  }
}

export const platformProfitService = {
  sumAgencyCommissionByRefIds,
  sumHostPointsByRefIds,
  profitForGiftRow,
  profitForFullCoinSpend,
  profitForWithdrawalRow,
  profitForCoinDebitRow,
  summarizePlatformProfit,
  summarizeAdminCurrencySupply,
  ZERO: ZERO_PLATFORM_PROFIT,
}
