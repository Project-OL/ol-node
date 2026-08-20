import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  Prisma,
  WalletCurrencyType,
  WithdrawalStatus,
} from '@prisma/client'
import { prismaRead } from '../config/database'
import { POINTS_PER_USD } from '../utils/points-currency'
import {
  profitFromCoinToPointSplit,
  profitFromFullCoinSink,
  profitFromWithdrawalFee,
} from '../utils/platform-profit'
import { companyAgencyService } from './companyAgency.service'
import { companyCashService } from './companyCash.service'
import { platformProfitService } from './platform-profit.service'

export type LedgerGrain = 'month' | 'quarter' | 'year' | 'custom'

export type LedgerLine = {
  id: string
  label: string
  units: string
  usd: string
}

function unitsToUsd(units: bigint): string {
  const sign = units < 0n ? '-' : ''
  const abs = units < 0n ? -units : units
  const whole = abs / POINTS_PER_USD
  const frac = abs % POINTS_PER_USD
  const fracStr = frac.toString().padStart(4, '0').slice(0, 2)
  return `${sign}${whole}.${fracStr}`
}

function line(id: string, label: string, units: bigint): LedgerLine {
  return { id, label, units: units.toString(), usd: unitsToUsd(units) }
}

function dateFilter(from?: Date, to?: Date): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined
  return {
    ...(from ? { gte: from } : {}),
    ...(to ? { lt: to } : {}),
  }
}

function startOfUtcMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0))
}

function startOfUtcQuarter(d: Date): Date {
  const q = Math.floor(d.getUTCMonth() / 3) * 3
  return new Date(Date.UTC(d.getUTCFullYear(), q, 1, 0, 0, 0, 0))
}

function startOfUtcYear(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1, 0, 0, 0, 0))
}

export function resolveLedgerPeriod(params: {
  from?: Date
  to?: Date
  grain?: LedgerGrain
  now?: Date
}): { from: Date; to: Date; grain: LedgerGrain } {
  const now = params.now ?? new Date()
  const grain = params.grain ?? (params.from || params.to ? 'custom' : 'month')
  if (grain === 'custom' && (params.from || params.to)) {
    const from = params.from ?? new Date(0)
    const to = params.to ?? now
    return { from, to, grain }
  }
  if (grain === 'year') {
    const from = startOfUtcYear(now)
    const to = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1))
    return { from, to, grain }
  }
  if (grain === 'quarter') {
    const from = startOfUtcQuarter(now)
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 3, 1))
    return { from, to, grain }
  }
  const from = startOfUtcMonth(now)
  const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
  return { from, to, grain: 'month' }
}

async function sumCoin(params: {
  direction: LedgerDirection
  txTypes: CoinTxType[]
  currency: WalletCurrencyType
  from?: Date
  to?: Date
  promotionalOnly?: boolean
}): Promise<bigint> {
  const createdAt = dateFilter(params.from, params.to)
  const agg = await prismaRead.coinLedgerEntry.aggregate({
    where: {
      direction: params.direction,
      txType: { in: params.txTypes },
      wallet: { currencyType: params.currency },
      ...(createdAt ? { createdAt } : {}),
      ...(params.promotionalOnly
        ? { metadata: { path: ['promotional'], equals: true } }
        : {}),
    },
    _sum: { amount: true },
  })
  return agg._sum.amount ?? 0n
}

async function sumPoint(params: {
  direction: LedgerDirection
  txTypes: PointTxType[]
  from?: Date
  to?: Date
  promotionalOnly?: boolean
}): Promise<bigint> {
  const createdAt = dateFilter(params.from, params.to)
  const agg = await prismaRead.pointLedgerEntry.aggregate({
    where: {
      direction: params.direction,
      txType: { in: params.txTypes },
      ...(createdAt ? { createdAt } : {}),
      ...(params.promotionalOnly
        ? { metadata: { path: ['promotional'], equals: true } }
        : {}),
    },
    _sum: { amount: true },
  })
  return agg._sum.amount ?? 0n
}

type WalletBalRow = {
  currency: string
  is_agent: boolean
  user_id: string
  balance: bigint
}

async function loadWalletBalancesAt(at: Date): Promise<WalletBalRow[]> {
  const coinRows = await prismaRead.$queryRaw<WalletBalRow[]>(Prisma.sql`
    SELECT w.currency_type::text AS currency,
           u.is_agent AS is_agent,
           w.user_id::text AS user_id,
           COALESCE(e.balance_after, 0) AS balance
    FROM wallets w
    JOIN users u ON u.id = w.user_id
    LEFT JOIN LATERAL (
      SELECT balance_after
      FROM coin_ledger_entries
      WHERE wallet_id = w.id AND created_at < ${at}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) e ON true
    WHERE w.currency_type IN ('COIN', 'TRADING_COIN')
  `)
  const pointRows = await prismaRead.$queryRaw<WalletBalRow[]>(Prisma.sql`
    SELECT w.currency_type::text AS currency,
           u.is_agent AS is_agent,
           w.user_id::text AS user_id,
           COALESCE(e.balance_after, 0) AS balance
    FROM wallets w
    JOIN users u ON u.id = w.user_id
    LEFT JOIN LATERAL (
      SELECT balance_after
      FROM point_ledger_entries
      WHERE wallet_id = w.id AND created_at < ${at}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ) e ON true
    WHERE w.currency_type = 'POINT'
  `)
  return [...coinRows, ...pointRows]
}

async function ledgerNetAt(at: Date): Promise<bigint> {
  const [coinCredit, coinDebit, pointCredit, pointDebit] = await Promise.all([
    prismaRead.coinLedgerEntry.aggregate({
      where: { direction: LedgerDirection.CREDIT, createdAt: { lt: at } },
      _sum: { amount: true },
    }),
    prismaRead.coinLedgerEntry.aggregate({
      where: { direction: LedgerDirection.DEBIT, createdAt: { lt: at } },
      _sum: { amount: true },
    }),
    prismaRead.pointLedgerEntry.aggregate({
      where: { direction: LedgerDirection.CREDIT, createdAt: { lt: at } },
      _sum: { amount: true },
    }),
    prismaRead.pointLedgerEntry.aggregate({
      where: { direction: LedgerDirection.DEBIT, createdAt: { lt: at } },
      _sum: { amount: true },
    }),
  ])
  return (
    (coinCredit._sum.amount ?? 0n) -
    (coinDebit._sum.amount ?? 0n) +
    (pointCredit._sum.amount ?? 0n) -
    (pointDebit._sum.amount ?? 0n)
  )
}

export const masterLedgerService = {
  unitsToUsd,

  async stock(at: Date) {
    const companyAgencyUserId = companyAgencyService.configuredUserId()
    const [rows, ledgerNet, mint, convertedCoinsCreated] = await Promise.all([
      loadWalletBalancesAt(at),
      ledgerNetAt(at),
      platformProfitService.summarizeAdminCurrencySupply({ to: at }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.POINT_EXCHANGE_TO_COINS],
        currency: WalletCurrencyType.COIN,
        to: at,
      }),
    ])

    let personalCoins = 0n
    let tradingCoins = 0n
    let hostPoints = 0n
    let agencyPoints = 0n
    let companyAgencyPoints = 0n
    let companyAgencyTrading = 0n

    for (const r of rows) {
      const bal = BigInt(r.balance ?? 0)
      if (r.currency === 'COIN') personalCoins += bal
      else if (r.currency === 'TRADING_COIN') {
        if (companyAgencyUserId && r.user_id === companyAgencyUserId) companyAgencyTrading += bal
        else tradingCoins += bal
      } else if (r.currency === 'POINT') {
        if (companyAgencyUserId && r.user_id === companyAgencyUserId) companyAgencyPoints += bal
        else if (r.is_agent) agencyPoints += bal
        else hostPoints += bal
      }
    }

    const outstanding =
      personalCoins + tradingCoins + hostPoints + agencyPoints + companyAgencyPoints + companyAgencyTrading
    const netMinted =
      BigInt(mint.created.coins) +
      BigInt(mint.created.points) +
      BigInt(mint.created.tradingCoins) -
      BigInt(mint.returned.coins) -
      BigInt(mint.returned.points) -
      BigInt(mint.returned.tradingCoins)
    const destroyedUnits = netMinted - outstanding
    const identityDelta = outstanding - ledgerNet
    const identityOk = identityDelta === 0n

    const inventory: LedgerLine[] = [
      line('personalCoins', 'User unspent coins', personalCoins),
      line('convertedCoinsCreated', 'Host coins created via point conversion (cumulative credits)', convertedCoinsCreated),
      line('tradingCoins', 'Agency trading-coin stock', tradingCoins),
      line('hostPoints', 'Host unconverted points', hostPoints),
      line('agencyPoints', 'Agency points (commission + payroll reward)', agencyPoints),
      line('companyAgencyPoints', 'Company-agency takeover points', companyAgencyPoints),
      line('companyAgencyTrading', 'Company-agency trading coins', companyAgencyTrading),
      line('outstanding', 'Total outstanding', outstanding),
      line('netMinted', 'Net admin issued', netMinted),
      line('destroyedUnits', 'Company retained (issued − outstanding)', destroyedUnits),
    ]

    return {
      at: at.toISOString(),
      companyAgencyUserId,
      identityOk,
      identityDelta: identityDelta.toString(),
      inventory,
      outstanding: outstanding.toString(),
      outstandingUsd: unitsToUsd(outstanding),
      netMinted: netMinted.toString(),
      destroyedUnits: destroyedUnits.toString(),
    }
  },

  async operatingPnl(from: Date, to: Date) {
    const createdAt = dateFilter(from, to)

    const giftAgg = await prismaRead.giftTransaction.aggregate({
      where: createdAt ? { createdAt } : undefined,
      _sum: { coinCost: true, pointsAwarded: true },
    })
    const [giftRefunds, giftAgencyReceive, giftAgencyLive] = await Promise.all([
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.GIFT_REFUND],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      prismaRead.pointLedgerEntry.aggregate({
        where: {
          direction: LedgerDirection.CREDIT,
          txType: PointTxType.AGENT_COMMISSION,
          createdAt,
          metadata: { path: ['hostTxType'], equals: PointTxType.GIFT_RECEIVE },
        },
        _sum: { amount: true },
      }),
      prismaRead.pointLedgerEntry.aggregate({
        where: {
          direction: LedgerDirection.CREDIT,
          txType: PointTxType.AGENT_COMMISSION,
          createdAt,
          metadata: { path: ['hostTxType'], equals: PointTxType.LIVESTREAM_GIFT },
        },
        _sum: { amount: true },
      }),
    ])
    const giftCoins = BigInt(giftAgg._sum.coinCost ?? 0) - giftRefunds
    const giftHost = BigInt(giftAgg._sum.pointsAwarded ?? 0)
    const giftAgency = (giftAgencyReceive._sum.amount ?? 0n) + (giftAgencyLive._sum.amount ?? 0n)
    const gifts = profitFromCoinToPointSplit({
      coinsSpent: giftCoins < 0n ? 0n : giftCoins,
      hostPoints: giftHost,
      agencyCommissionPoints: giftAgency,
    }).rawCoins

    const splitPairs = [
      {
        id: 'videoCalls',
        label: 'Video calls',
        coinType: CoinTxType.VIDEO_CALL,
        pointType: PointTxType.VIDEO_CALL,
      },
      {
        id: 'subscriptions',
        label: 'Subscriptions',
        coinType: CoinTxType.CREATOR_SUBSCRIPTION,
        pointType: PointTxType.SUBSCRIPTION,
      },
      {
        id: 'guardian',
        label: 'Guardian',
        coinType: CoinTxType.GUARDIAN_PURCHASE,
        pointType: PointTxType.GUARDIAN_PURCHASE,
      },
    ] as const

    const splitLines: { id: string; label: string; units: bigint }[] = []
    for (const p of splitPairs) {
      const [coins, host, agency] = await Promise.all([
        sumCoin({
          direction: LedgerDirection.DEBIT,
          txTypes: [p.coinType],
          currency: WalletCurrencyType.COIN,
          from,
          to,
        }),
        sumPoint({
          direction: LedgerDirection.CREDIT,
          txTypes: [p.pointType],
          from,
          to,
        }),
        prismaRead.pointLedgerEntry.aggregate({
          where: {
            direction: LedgerDirection.CREDIT,
            txType: PointTxType.AGENT_COMMISSION,
            createdAt,
            metadata: { path: ['hostTxType'], equals: p.pointType },
          },
          _sum: { amount: true },
        }),
      ])
      splitLines.push({
        id: p.id,
        label: p.label,
        units: profitFromCoinToPointSplit({
          coinsSpent: coins,
          hostPoints: host,
          agencyCommissionPoints: agency._sum.amount ?? 0n,
        }).rawCoins,
      })
    }

    const [
      store,
      vipMembership,
      vipRare,
      username,
      globalMessage,
      customGift,
      customRefund,
      pointExchangeOut,
      coinExchangeIn,
      tradingExchangeIn,
      dailyLogin,
      weeklyTopup,
      platformRewardCoins,
      vipReward,
      streak,
      promoCoins,
      promoPoints,
      promoTrading,
    ] = await Promise.all([
      prismaRead.userStoreItem.aggregate({
        where: createdAt ? { createdAt } : undefined,
        _sum: { coinsPaid: true },
      }),
      prismaRead.vipMembershipPurchase.aggregate({
        where: createdAt ? { createdAt } : undefined,
        _sum: { coinCost: true },
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.VIP_PURCHASE],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.USERNAME_CHANGE],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.GLOBAL_MESSAGE],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.CUSTOM_GIFT_REQUEST],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.CUSTOM_GIFT_REFUND],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumPoint({
        direction: LedgerDirection.DEBIT,
        txTypes: [PointTxType.TRANSFER_OUT],
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.POINT_EXCHANGE_TO_COINS],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.TRADING_EXCHANGE_FROM_POINTS],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.DAILY_LOGIN],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.WEEKLY_TOPUP],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.PLATFORM_REWARD],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.VIP_REWARD],
        currency: WalletCurrencyType.COIN,
        from,
        to,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.LIVESTREAM_STREAK_REWARD, PointTxType.PLATFORM_REWARD],
        from,
        to,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        promotionalOnly: true,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.ADJUSTMENT],
        from,
        to,
        promotionalOnly: true,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
        promotionalOnly: true,
      }),
    ])

    const storeUnits = profitFromFullCoinSink(BigInt(store._sum.coinsPaid ?? 0))
    const conversionSpread = pointExchangeOut - coinExchangeIn - tradingExchangeIn
    const customNet = customGift - customRefund
    const promoCost = promoCoins + promoPoints + promoTrading
    const rewardCost =
      dailyLogin + weeklyTopup + platformRewardCoins + vipReward + streak + promoCost

    const withdrawals = await prismaRead.withdrawal.findMany({
      where: {
        platformFeePoints: { not: null },
        status: { in: [WithdrawalStatus.PAID, WithdrawalStatus.WAITING] },
        OR: [{ processedAt: createdAt }, { processedAt: null, requestedAt: createdAt }],
      },
      select: { platformFeePoints: true, agentRewardPoints: true, serviceFeePoints: true },
    })
    let withdrawShare = 0n
    for (const w of withdrawals) {
      withdrawShare += profitFromWithdrawalFee({
        platformFeePoints: w.platformFeePoints ?? 0n,
        agentRewardPoints: w.agentRewardPoints ?? 0n,
        serviceFeePoints: w.serviceFeePoints ?? 0n,
      }).rawPoints
    }

    const revenueLines: LedgerLine[] = [
      line('gifts', 'Gifts (net of lucky refunds)', gifts < 0n ? 0n : gifts),
      ...splitLines.map((s) => line(s.id, s.label, s.units < 0n ? 0n : s.units)),
      line('store', 'Store', BigInt(storeUnits.coins)),
      line('vipMembership', 'VIP membership', vipMembership._sum.coinCost ?? 0n),
      line('vipRareId', 'Rare ID', vipRare),
      line('usernameChange', 'Username change', username),
      line('globalMessage', 'Global message', globalMessage),
      line('customGifts', 'Custom gifts (net)', customNet < 0n ? 0n : customNet),
      line('conversionSpread', 'Point→coin conversion spread', conversionSpread < 0n ? 0n : conversionSpread),
      line('withdrawCompanyShare', 'Withdraw company share (40% of fee + EPAY service)', withdrawShare),
    ]
    const costLines: LedgerLine[] = [
      line('rewards', 'Platform rewards / login / streak / promo mint', -rewardCost),
    ]
    let operating = 0n
    for (const l of revenueLines) operating += BigInt(l.units)
    operating -= rewardCost

    return {
      revenue: revenueLines,
      costs: costLines,
      operatingProfitUnits: operating.toString(),
      operatingProfitUsd: unitsToUsd(operating),
    }
  },

  async dashboard(params: { from?: Date; to?: Date; grain?: LedgerGrain; at?: Date }) {
    const period = resolveLedgerPeriod({
      from: params.from,
      to: params.to,
      grain: params.grain,
    })
    const at = params.at ?? period.to
    const [stock, pnl, cash] = await Promise.all([
      this.stock(at),
      this.operatingPnl(period.from, period.to),
      companyCashService.periodCash({ from: period.from, to: period.to }),
    ])
    return {
      period: {
        grain: period.grain,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      hero: {
        capitalInUsd: cash.capitalInUsd,
        cashOutUsd: cash.cashOutUsd,
        cashProfitUsd: cash.cashProfitUsd,
        operatingProfitUnits: pnl.operatingProfitUnits,
        operatingProfitUsd: pnl.operatingProfitUsd,
        identityOk: stock.identityOk,
        identityDelta: stock.identityDelta,
      },
      stock,
      pnl,
      cash,
    }
  },
}
