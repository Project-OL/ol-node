import {
  CoinTxType,
  LedgerDirection,
  PointTxType,
  Prisma,
  WalletCurrencyType,
} from '@prisma/client'
import { prismaRead } from '../config/database'
import { POINTS_PER_USD, unitsToUsd } from '../utils/points-currency'
import {
  profitFromCoinToPointSplit,
  profitFromFullCoinSink,
  profitFromWithdrawalFee,
} from '../utils/platform-profit'
import { companyCashService } from './companyCash.service'
import { platformProfitService } from './platform-profit.service'
import { ledgerAccountRoleService, type HouseAccounts } from './ledgerAccountRole.service'
import { treasuryFlowService } from './treasuryFlow.service'
import { AppError } from '../middlewares/errorHandler'
import { ledgerFloatSnapshotRepository } from '../repositories/ledgerFloatSnapshot.repository'

/**
 * Master ledger — unit-based accounting at a fixed 10,000 units = $1.
 *
 * Accounts are either HOUSE (treasury + company agency) or CUSTOMER. House
 * balances are unsold inventory, not liabilities; their outflows are imputed
 * sales. Because consumption moves value out of customer float by exactly the
 * margin retained, the two reports cross-validate:
 *
 *   gross sale units − company payout units = Δ customer float + operating profit
 *
 * Promo grants and reward mints cancel out of that identity (they raise float
 * and lower operating profit equally), so a non-zero delta means a real problem
 * — most often a house account that was never registered.
 */

export type LedgerGrain = 'today' | 'yesterday' | 'month' | 'quarter' | 'year' | 'custom'

/** Maximum inclusive span for custom ledger periods (730 days). */
export const MAX_CUSTOM_LEDGER_PERIOD_MS = 730 * 24 * 60 * 60 * 1000

export type LedgerLine = {
  id: string
  label: string
  units: string
  usd: string
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

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

/** Reject custom periods longer than {@link MAX_CUSTOM_LEDGER_PERIOD_MS}. */
export function assertCustomLedgerPeriodSpan(from: Date, to: Date): void {
  if (to.getTime() - from.getTime() > MAX_CUSTOM_LEDGER_PERIOD_MS) {
    throw new AppError(400, 'Custom period cannot exceed 730 days (2 years)', 'INVALID_REQUEST')
  }
  if (to.getTime() <= from.getTime()) {
    throw new AppError(400, 'Period end must be after period start', 'INVALID_REQUEST')
  }
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
    assertCustomLedgerPeriodSpan(from, to)
    return { from, to, grain }
  }
  if (grain === 'today') {
    const from = startOfUtcDay(now)
    const to = new Date(from.getTime() + 24 * 60 * 60 * 1000)
    return { from, to, grain }
  }
  if (grain === 'yesterday') {
    const to = startOfUtcDay(now)
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
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

/** Which side of the house/customer split a ledger aggregate should cover. */
type Owner = 'customer' | 'house' | 'any'

/**
 * Wallet-owner filter. An empty house registry means every account is a
 * customer, so the `notIn` clause is omitted rather than emitting `NOT IN ()`.
 */
function ownerFilter(owner: Owner, house: HouseAccounts): { userId?: Prisma.UuidFilter } {
  const ids = [...house.allIds]
  if (owner === 'any' || ids.length === 0) {
    return owner === 'house' ? { userId: { in: ids } } : {}
  }
  return owner === 'house' ? { userId: { in: ids } } : { userId: { notIn: ids } }
}

async function sumCoin(params: {
  direction: LedgerDirection
  txTypes: CoinTxType[]
  currency: WalletCurrencyType
  from?: Date
  to?: Date
  promotionalOnly?: boolean
  owner?: Owner
  house?: HouseAccounts
}): Promise<bigint> {
  const createdAt = dateFilter(params.from, params.to)
  const owner = params.owner ?? 'any'
  const ownerWhere = params.house ? ownerFilter(owner, params.house) : {}
  const agg = await prismaRead.coinLedgerEntry.aggregate({
    where: {
      direction: params.direction,
      txType: { in: params.txTypes },
      wallet: { currencyType: params.currency, ...ownerWhere },
      ...(createdAt ? { createdAt } : {}),
      ...(params.promotionalOnly ? { metadata: { path: ['promotional'], equals: true } } : {}),
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
  owner?: Owner
  house?: HouseAccounts
}): Promise<bigint> {
  const createdAt = dateFilter(params.from, params.to)
  const owner = params.owner ?? 'any'
  const ownerWhere = params.house ? ownerFilter(owner, params.house) : {}
  const agg = await prismaRead.pointLedgerEntry.aggregate({
    where: {
      direction: params.direction,
      txType: { in: params.txTypes },
      ...(Object.keys(ownerWhere).length > 0 ? { wallet: ownerWhere } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(params.promotionalOnly ? { metadata: { path: ['promotional'], equals: true } } : {}),
    },
    _sum: { amount: true },
  })
  return agg._sum.amount ?? 0n
}

/** Agency commission credited to customer agencies for one host tx type. */
async function sumAgencyCommission(params: {
  hostTxType: PointTxType
  from?: Date
  to?: Date
  house: HouseAccounts
}): Promise<bigint> {
  const createdAt = dateFilter(params.from, params.to)
  const ownerWhere = ownerFilter('customer', params.house)
  const agg = await prismaRead.pointLedgerEntry.aggregate({
    where: {
      direction: LedgerDirection.CREDIT,
      txType: PointTxType.AGENT_COMMISSION,
      ...(createdAt ? { createdAt } : {}),
      ...(Object.keys(ownerWhere).length > 0 ? { wallet: ownerWhere } : {}),
      metadata: { path: ['hostTxType'], equals: params.hostTxType },
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

/** Raw unit buckets at an instant, split house vs customer. */
export type FloatBuckets = {
  customerCoins: bigint
  customerTradingCoins: bigint
  customerHostPoints: bigint
  customerAgencyPoints: bigint
  customerTotal: bigint
  houseCoins: bigint
  houseTradingCoins: bigint
  housePoints: bigint
  houseTotal: bigint
  ledgerNet: bigint
  identityDelta: bigint
}

export const ZERO_FLOAT: FloatBuckets = {
  customerCoins: 0n,
  customerTradingCoins: 0n,
  customerHostPoints: 0n,
  customerAgencyPoints: 0n,
  customerTotal: 0n,
  houseCoins: 0n,
  houseTradingCoins: 0n,
  housePoints: 0n,
  houseTotal: 0n,
  ledgerNet: 0n,
  identityDelta: 0n,
}

/** Full wallet scan at `at`. Prefer {@link floatAt} so snapshots are reused. */
export async function computeFloatAt(at: Date, house: HouseAccounts): Promise<FloatBuckets> {
  const [rows, ledgerNet] = await Promise.all([loadWalletBalancesAt(at), ledgerNetAt(at)])

  const b: FloatBuckets = { ...ZERO_FLOAT, ledgerNet }
  for (const r of rows) {
    const bal = BigInt(r.balance ?? 0)
    const isHouse = house.allIds.has(r.user_id)
    if (r.currency === 'COIN') {
      if (isHouse) b.houseCoins += bal
      else b.customerCoins += bal
    } else if (r.currency === 'TRADING_COIN') {
      if (isHouse) b.houseTradingCoins += bal
      else b.customerTradingCoins += bal
    } else if (r.currency === 'POINT') {
      if (isHouse) b.housePoints += bal
      else if (r.is_agent) b.customerAgencyPoints += bal
      else b.customerHostPoints += bal
    }
  }

  b.customerTotal =
    b.customerCoins + b.customerTradingCoins + b.customerHostPoints + b.customerAgencyPoints
  b.houseTotal = b.houseCoins + b.houseTradingCoins + b.housePoints
  // Identity spans every wallet: house + customer must equal global credit − debit.
  b.identityDelta = b.customerTotal + b.houseTotal - b.ledgerNet
  return b
}

/**
 * Float at `at`, served from the daily snapshot when one exists for that exact
 * instant. Period starts land on UTC day boundaries so they normally hit the
 * snapshot, leaving only the period end to be scanned live.
 */
export async function floatAt(
  at: Date,
  house: HouseAccounts,
  opts?: { allowSnapshot?: boolean },
): Promise<{ buckets: FloatBuckets; source: 'snapshot' | 'live' }> {
  if (opts?.allowSnapshot !== false) {
    const snap = await ledgerFloatSnapshotRepository.findAt(at)
    if (snap) {
      return {
        source: 'snapshot',
        buckets: {
          customerCoins: snap.customerCoins,
          customerTradingCoins: snap.customerTradingCoins,
          customerHostPoints: snap.customerHostPoints,
          customerAgencyPoints: snap.customerAgencyPoints,
          customerTotal: snap.customerTotal,
          houseCoins: snap.houseCoins,
          houseTradingCoins: snap.houseTradingCoins,
          housePoints: snap.housePoints,
          houseTotal: snap.houseTotal,
          ledgerNet: snap.ledgerNet,
          identityDelta: snap.identityDelta,
        },
      }
    }
  }
  return { source: 'live', buckets: await computeFloatAt(at, house) }
}

/** Company fiat actually paid out, expressed in units. */
async function companyPayoutUnits(from?: Date, to?: Date): Promise<bigint> {
  const rows = await prismaRead.$queryRaw<{ units: bigint | null }[]>(Prisma.sql`
    SELECT COALESCE(
             SUM(COALESCE(units_amount, ROUND(amount_usd * ${POINTS_PER_USD.toString()}::numeric)::bigint)),
             0
           ) AS units
    FROM company_cash_entries
    WHERE direction = 'OUT'
      AND promotional = false
      ${from ? Prisma.sql`AND created_at >= ${from}` : Prisma.empty}
      ${to ? Prisma.sql`AND created_at < ${to}` : Prisma.empty}
  `)
  return BigInt(rows[0]?.units ?? 0)
}

/** Units that left customer accounts back into a house account (sale refunds). */
async function returnsToHouseUnits(house: HouseAccounts, from?: Date, to?: Date): Promise<bigint> {
  if (house.allIds.size === 0) return 0n
  const ids = Prisma.join([...house.allIds].map((id) => Prisma.sql`${id}::uuid`))
  const [coin, point] = await Promise.all([
    prismaRead.$queryRaw<{ units: bigint | null }[]>(Prisma.sql`
      SELECT COALESCE(SUM(t.trading_coins_debited), 0) AS units
      FROM coin_trading_transfers t
      WHERE t.recipient_user_id IN (${ids})
        AND t.sender_agent_user_id NOT IN (${ids})
        AND t.reversed_at IS NULL
        ${from ? Prisma.sql`AND t.created_at >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND t.created_at < ${to}` : Prisma.empty}
    `),
    prismaRead.$queryRaw<{ units: bigint | null }[]>(Prisma.sql`
      SELECT COALESCE(SUM(t.points), 0) AS units
      FROM agent_point_transfers t
      WHERE t.recipient_agent_user_id IN (${ids})
        AND t.sender_agent_user_id NOT IN (${ids})
        ${from ? Prisma.sql`AND t.created_at >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND t.created_at < ${to}` : Prisma.empty}
    `),
  ])
  return BigInt(coin[0]?.units ?? 0) + BigInt(point[0]?.units ?? 0)
}

export const masterLedgerService = {
  unitsToUsd,

  async stock(at: Date, houseArg?: HouseAccounts) {
    const house = houseArg ?? (await ledgerAccountRoleService.getHouseAccounts())
    const [{ buckets }, mint, convertedCoinsCreated, houseMinted] = await Promise.all([
      floatAt(at, house, { allowSnapshot: false }),
      platformProfitService.summarizeAdminCurrencySupply({ to: at }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.POINT_EXCHANGE_TO_COINS],
        currency: WalletCurrencyType.COIN,
        to: at,
      }),
      house.allIds.size === 0
        ? Promise.resolve(0n)
        : (async () => {
            const [coinC, coinD, tradeC, tradeD, pointC, pointD] = await Promise.all([
              sumCoin({
                direction: LedgerDirection.CREDIT,
                txTypes: [CoinTxType.ADJUSTMENT],
                currency: WalletCurrencyType.COIN,
                to: at,
                owner: 'house',
                house,
              }),
              sumCoin({
                direction: LedgerDirection.DEBIT,
                txTypes: [CoinTxType.ADJUSTMENT],
                currency: WalletCurrencyType.COIN,
                to: at,
                owner: 'house',
                house,
              }),
              sumCoin({
                direction: LedgerDirection.CREDIT,
                txTypes: [CoinTxType.ADJUSTMENT],
                currency: WalletCurrencyType.TRADING_COIN,
                to: at,
                owner: 'house',
                house,
              }),
              sumCoin({
                direction: LedgerDirection.DEBIT,
                txTypes: [CoinTxType.ADJUSTMENT],
                currency: WalletCurrencyType.TRADING_COIN,
                to: at,
                owner: 'house',
                house,
              }),
              sumPoint({
                direction: LedgerDirection.CREDIT,
                txTypes: [PointTxType.ADJUSTMENT],
                to: at,
                owner: 'house',
                house,
              }),
              sumPoint({
                direction: LedgerDirection.DEBIT,
                txTypes: [PointTxType.ADJUSTMENT],
                to: at,
                owner: 'house',
                house,
              }),
            ])
            return coinC - coinD + tradeC - tradeD + pointC - pointD
          })(),
    ])

    const netMinted =
      BigInt(mint.created.coins) +
      BigInt(mint.created.points) +
      BigInt(mint.created.tradingCoins) -
      BigInt(mint.returned.coins) -
      BigInt(mint.returned.points) -
      BigInt(mint.returned.tradingCoins)

    const outstanding = buckets.customerTotal
    const totalUnits = buckets.customerTotal + buckets.houseTotal
    const destroyedUnits = netMinted - totalUnits

    const customerFloat: LedgerLine[] = [
      line('userCoins', 'User unspent coins', buckets.customerCoins),
      line('agencyTradingCoins', 'Agency trading-coin stock', buckets.customerTradingCoins),
      line('hostPoints', 'Host unconverted points', buckets.customerHostPoints),
      line('agencyPoints', 'Agency points (commission + payroll)', buckets.customerAgencyPoints),
      line('customerFloatTotal', 'Total customer float (liability)', buckets.customerTotal),
    ]

    const houseInventory: LedgerLine[] = [
      line('houseCoins', 'House personal coins', buckets.houseCoins),
      line('houseTradingCoins', 'House trading-coin inventory', buckets.houseTradingCoins),
      line('housePoints', 'House points (incl. takeover inventory)', buckets.housePoints),
      line('houseInventoryTotal', 'Total house inventory (not a liability)', buckets.houseTotal),
    ]

    return {
      at: at.toISOString(),
      houseAccountIds: [...house.allIds],
      treasuryAccountIds: [...house.treasuryIds],
      companyAgencyAccountIds: [...house.companyAgencyIds],
      /** Kept for the pre-treasury response shape. */
      companyAgencyUserId: [...house.companyAgencyIds][0] ?? null,
      identityOk: buckets.identityDelta === 0n,
      identityDelta: buckets.identityDelta.toString(),
      customerFloat,
      houseInventory,
      /** Legacy combined view: customer float first, then house inventory. */
      inventory: [
        ...customerFloat,
        ...houseInventory,
        line(
          'convertedCoinsCreated',
          'Host coins created via point conversion (cumulative, memo)',
          convertedCoinsCreated,
        ),
        line('netMinted', 'Net admin issued', netMinted),
      ],
      outstanding: outstanding.toString(),
      outstandingUsd: unitsToUsd(outstanding),
      customerFloatUnits: buckets.customerTotal.toString(),
      customerFloatUsd: unitsToUsd(buckets.customerTotal),
      houseInventoryUnits: buckets.houseTotal.toString(),
      houseInventoryUsd: unitsToUsd(buckets.houseTotal),
      totalUnits: totalUnits.toString(),
      netMinted: netMinted.toString(),
      houseMinted: houseMinted.toString(),
      destroyedUnits: destroyedUnits.toString(),
      ledgerNet: buckets.ledgerNet.toString(),
    }
  },

  /**
   * Imputed cash view: units sold out of house inventory valued at 10,000 = $1,
   * less the fiat the company actually paid out and the units it gave away.
   */
  async imputedCash(from: Date, to: Date, houseArg?: HouseAccounts) {
    const house = houseArg ?? (await ledgerAccountRoleService.getHouseAccounts())

    const [
      treasury,
      epayCoinTopups,
      epayTradingTopups,
      adminCreditsCoin,
      adminCreditsTrading,
      adminCreditsPoint,
      promoCoins,
      promoTrading,
      promoPoints,
      payouts,
      returnsToHouse,
    ] = await Promise.all([
      treasuryFlowService.periodTotals({ from, to }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.TOPUP],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.TRADING_TOPUP],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.ADJUSTMENT],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        promotionalOnly: true,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
        promotionalOnly: true,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.ADJUSTMENT],
        from,
        to,
        promotionalOnly: true,
        owner: 'customer',
        house,
      }),
      companyPayoutUnits(from, to),
      returnsToHouseUnits(house, from, to),
    ])

    const promoAdminMints = promoCoins + promoTrading + promoPoints
    // Promotional credits are a cost, so they must not also count as a sale.
    const directAdminSales =
      adminCreditsCoin + adminCreditsTrading + adminCreditsPoint - promoAdminMints
    const treasuryGiveaway = treasury.promoUnits + treasury.writeOffUnits

    const revenue: LedgerLine[] = [
      line('treasurySales', 'Treasury unit sales (imputed)', treasury.saleUnits),
      line('treasurySaleReversals', 'Treasury sale reversals', -treasury.reversedSaleUnits),
      line('returnsToHouse', 'Units returned to house accounts', -returnsToHouse),
      line('epayCoinTopups', 'Epay personal coin top-ups', epayCoinTopups),
      line('epayTradingTopups', 'Epay trading-coin top-ups', epayTradingTopups),
      line('directAdminSales', 'Direct admin mints to customers', directAdminSales),
    ]

    let grossSaleUnits = 0n
    for (const l of revenue) grossSaleUnits += BigInt(l.units)

    const costs: LedgerLine[] = [
      line('companyPayouts', 'Company fiat payouts (EPAY + takeover)', -payouts),
      line('treasuryGiveaway', 'Treasury promo / write-off grants', -treasuryGiveaway),
      line('promoAdminMints', 'Promotional admin mints', -promoAdminMints),
    ]

    const netMargin = grossSaleUnits - payouts - treasuryGiveaway - promoAdminMints

    return {
      revenue,
      costs,
      grossSaleUnits: grossSaleUnits.toString(),
      grossSaleUsd: unitsToUsd(grossSaleUnits),
      companyPayoutUnits: payouts.toString(),
      companyPayoutUsd: unitsToUsd(payouts),
      netMarginUnits: netMargin.toString(),
      netMarginUsd: unitsToUsd(netMargin),
      saleCount: treasury.saleCount,
      treasuryConfigured: house.treasuryIds.size > 0,
      /** Raw figures the reconciliation identity consumes. */
      _internal: {
        grossSaleUnits,
        payouts,
        treasuryGiveaway,
        promoAdminMints,
      },
    }
  },

  /**
   * Consumption P&L. Revenue is recognised when units are spent, not when they
   * are sold, so this and {@link imputedCash} only agree once customer float is
   * flat.
   */
  async operatingPnl(from: Date, to: Date, houseArg?: HouseAccounts) {
    const house = houseArg ?? (await ledgerAccountRoleService.getHouseAccounts())
    const createdAt = dateFilter(from, to)

    // Gift margin from ledgers (not gift_transactions.coinCost): live combo rows
    // can under-store coinCost while GIFT_SEND / GIFT_RECEIVE stay correct.
    // Agency commission rule unchanged — AGENT_COMMISSION filtered by hostTxType meta.
    const [giftSendCoins, giftRefunds, giftHost, giftAgencyReceive, giftAgencyLive] =
      await Promise.all([
        sumCoin({
          direction: LedgerDirection.DEBIT,
          txTypes: [CoinTxType.GIFT_SEND],
          currency: WalletCurrencyType.COIN,
          from,
          to,
        }),
        sumCoin({
          direction: LedgerDirection.CREDIT,
          txTypes: [CoinTxType.GIFT_REFUND],
          currency: WalletCurrencyType.COIN,
          from,
          to,
        }),
        sumPoint({
          direction: LedgerDirection.CREDIT,
          txTypes: [PointTxType.GIFT_RECEIVE, PointTxType.LIVESTREAM_GIFT],
          from,
          to,
          owner: 'customer',
          house,
        }),
        sumAgencyCommission({ hostTxType: PointTxType.GIFT_RECEIVE, from, to, house }),
        sumAgencyCommission({ hostTxType: PointTxType.LIVESTREAM_GIFT, from, to, house }),
      ])
    const giftCoins = giftSendCoins - giftRefunds
    const giftAgency = giftAgencyReceive + giftAgencyLive
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
          owner: 'customer',
          house,
        }),
        sumAgencyCommission({ hostTxType: p.pointType, from, to, house }),
      ])
      splitLines.push({
        id: p.id,
        label: p.label,
        units: profitFromCoinToPointSplit({
          coinsSpent: coins,
          hostPoints: host,
          agencyCommissionPoints: agency,
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
      coinExpiry,
      forceExitPenalty,
      adminClawbackCoin,
      adminClawbackTrading,
      adminClawbackPoint,
      withdrawalDebits,
      withdrawalCustomerCredits,
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
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.WEEKLY_TOPUP],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.PLATFORM_REWARD],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.VIP_REWARD],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.LIVESTREAM_STREAK_REWARD, PointTxType.PLATFORM_REWARD],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        promotionalOnly: true,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.ADJUSTMENT],
        from,
        to,
        promotionalOnly: true,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.CREDIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
        promotionalOnly: true,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.EXPIRE],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.DEBIT,
        txTypes: [PointTxType.AGENCY_FORCE_EXIT_PENALTY],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumCoin({
        direction: LedgerDirection.DEBIT,
        txTypes: [CoinTxType.ADJUSTMENT],
        currency: WalletCurrencyType.TRADING_COIN,
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.DEBIT,
        txTypes: [PointTxType.ADJUSTMENT],
        from,
        to,
        owner: 'customer',
        house,
      }),
      // Withdrawal subsystem is measured from the ledger rather than the
      // withdrawals table so refunds, disputes, takeovers and cross-period
      // settlement all net out on their own.
      sumPoint({
        direction: LedgerDirection.DEBIT,
        txTypes: [PointTxType.WITHDRAWAL, PointTxType.WITHDRAWAL_ESCROW_SETTLED],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [
          PointTxType.PAYROLL_HOST_PAYOUT,
          PointTxType.PAYROLL_PROCESSING_REWARD,
          PointTxType.PAYROLL_TAKEOVER_INVENTORY,
          PointTxType.WITHDRAWAL_REFUND,
        ],
        from,
        to,
        owner: 'customer',
        house,
      }),
    ])

    const payouts = await companyPayoutUnits(from, to)

    const storeUnits = profitFromFullCoinSink(BigInt(store._sum.coinsPaid ?? 0))
    const conversionSpread = pointExchangeOut - coinExchangeIn - tradingExchangeIn
    const customNet = customGift - customRefund
    const promoAdminMints = promoCoins + promoPoints + promoTrading
    const rewardCost = dailyLogin + weeklyTopup + platformRewardCoins + vipReward + streak
    const adminClawback = adminClawbackCoin + adminClawbackTrading + adminClawbackPoint
    // Net float reduction caused by the withdrawal subsystem, minus the fiat the
    // company itself paid (that leg is a cost in the imputed-cash report).
    const withdrawalNet = withdrawalDebits - withdrawalCustomerCredits - payouts

    const treasury = await treasuryFlowService.periodTotals({ from, to })
    const treasuryGiveaway = treasury.promoUnits + treasury.writeOffUnits

    // Fee-snapshot view of the same economics, kept as a memo because the
    // ledger-derived line above is what reconciles.
    const withdrawals = await prismaRead.withdrawal.findMany({
      where: {
        platformFeePoints: { not: null },
        status: { in: ['PAID', 'WAITING'] },
        OR: [{ processedAt: createdAt }, { processedAt: null, requestedAt: createdAt }],
      },
      select: { platformFeePoints: true, agentRewardPoints: true, serviceFeePoints: true },
    })
    let feeShareMemo = 0n
    for (const w of withdrawals) {
      feeShareMemo += profitFromWithdrawalFee({
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
      line(
        'conversionSpread',
        'Point→coin conversion spread',
        conversionSpread < 0n ? 0n : conversionSpread,
      ),
      line('withdrawalNet', 'Withdrawal retention (net of company payouts)', withdrawalNet),
      line('coinExpiry', 'Expired coins', coinExpiry),
      line('forceExitPenalty', 'Agency force-exit penalties', forceExitPenalty),
      line('adminClawback', 'Admin clawbacks from customers', adminClawback),
    ]
    const costLines: LedgerLine[] = [
      line('rewards', 'Platform rewards / login / streak', -rewardCost),
      line('promoAdminMints', 'Promotional admin mints', -promoAdminMints),
      line('treasuryGiveaway', 'Treasury promo / write-off grants', -treasuryGiveaway),
    ]

    let operating = 0n
    for (const l of revenueLines) operating += BigInt(l.units)
    for (const l of costLines) operating += BigInt(l.units)

    return {
      revenue: revenueLines,
      costs: costLines,
      memo: [
        line('withdrawFeeShareMemo', 'Withdrawal fee share (fee-snapshot view)', feeShareMemo),
        line('hostPointsEarned', 'Host points earned from spend', giftHost),
        line('agencyCommission', 'Agency commission minted', giftAgency),
      ],
      operatingProfitUnits: operating.toString(),
      operatingProfitUsd: unitsToUsd(operating),
    }
  },

  /** Non-additive breakdown of where units moved inside customer float. */
  async unitFlowMemo(from: Date, to: Date, house: HouseAccounts) {
    const [
      hostPoints,
      agencyCommission,
      agencyPayroll,
      takeoverInventory,
      withdrawalDebits,
      withdrawalRefunds,
      rewardPoints,
    ] = await Promise.all([
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [
          PointTxType.GIFT_RECEIVE,
          PointTxType.LIVESTREAM_GIFT,
          PointTxType.VIDEO_CALL,
          PointTxType.SUBSCRIPTION,
          PointTxType.GUARDIAN_PURCHASE,
        ],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.AGENT_COMMISSION],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.PAYROLL_HOST_PAYOUT, PointTxType.PAYROLL_PROCESSING_REWARD],
        from,
        to,
        owner: 'customer',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.PAYROLL_TAKEOVER_INVENTORY],
        from,
        to,
        owner: 'house',
        house,
      }),
      sumPoint({
        direction: LedgerDirection.DEBIT,
        txTypes: [PointTxType.WITHDRAWAL, PointTxType.WITHDRAWAL_ESCROW_SETTLED],
        from,
        to,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.WITHDRAWAL_REFUND],
        from,
        to,
      }),
      sumPoint({
        direction: LedgerDirection.CREDIT,
        txTypes: [PointTxType.LIVESTREAM_STREAK_REWARD, PointTxType.PLATFORM_REWARD],
        from,
        to,
        owner: 'customer',
        house,
      }),
    ])

    return [
      line('hostPointsEarned', 'Host points earned from user spend', hostPoints),
      line('agencyCommissionMinted', 'Agency commission points minted', agencyCommission),
      line('agencyPayrollCredits', 'Agency payroll credits (liability transfer)', agencyPayroll),
      line('takeoverInventory', 'Company-agency takeover inventory', takeoverInventory),
      line('withdrawalsSettled', 'Host points withdrawn (gross)', withdrawalDebits),
      line('withdrawalRefunds', 'Withdrawal refunds returned', withdrawalRefunds),
      line('rewardPointsMinted', 'Reward points minted', rewardPoints),
    ]
  },

  async dashboard(params: { from?: Date; to?: Date; grain?: LedgerGrain; at?: Date }) {
    const period = resolveLedgerPeriod({
      from: params.from,
      to: params.to,
      grain: params.grain,
    })
    const at = params.at ?? period.to
    const house = await ledgerAccountRoleService.getHouseAccounts()

    const [stock, pnl, imputed, cash, openingFloat, memo] = await Promise.all([
      this.stock(at, house),
      this.operatingPnl(period.from, period.to, house),
      this.imputedCash(period.from, period.to, house),
      companyCashService.periodCash({ from: period.from, to: period.to }),
      floatAt(period.from, house),
      this.unitFlowMemo(period.from, period.to, house),
    ])

    // gross sales − company payouts = Δ customer float + operating profit
    const closingFloatUnits = BigInt(stock.customerFloatUnits)
    const openingFloatUnits = openingFloat.buckets.customerTotal
    const deltaFloat = closingFloatUnits - openingFloatUnits
    const lhs = imputed._internal.grossSaleUnits - imputed._internal.payouts
    const rhs = deltaFloat + BigInt(pnl.operatingProfitUnits)
    const reconciliationDelta = lhs - rhs

    const { _internal, ...imputedPublic } = imputed

    return {
      period: {
        grain: period.grain,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      hero: {
        // Legacy key names retained; now carrying the imputed figures.
        capitalInUsd: imputed.grossSaleUsd,
        cashOutUsd: imputed.companyPayoutUsd,
        cashProfitUsd: imputed.netMarginUsd,
        operatingProfitUnits: pnl.operatingProfitUnits,
        operatingProfitUsd: pnl.operatingProfitUsd,
        identityOk: stock.identityOk,
        identityDelta: stock.identityDelta,
        grossSaleUnits: imputed.grossSaleUnits,
        grossSaleUsd: imputed.grossSaleUsd,
        companyPayoutUnits: imputed.companyPayoutUnits,
        companyPayoutUsd: imputed.companyPayoutUsd,
        netImputedMarginUnits: imputed.netMarginUnits,
        netImputedMarginUsd: imputed.netMarginUsd,
        customerFloatUnits: stock.customerFloatUnits,
        customerFloatUsd: stock.customerFloatUsd,
        houseInventoryUnits: stock.houseInventoryUnits,
        houseInventoryUsd: stock.houseInventoryUsd,
        treasuryConfigured: imputed.treasuryConfigured,
        reconciliationOk: reconciliationDelta === 0n,
        reconciliationDelta: reconciliationDelta.toString(),
      },
      stock,
      pnl,
      imputed: imputedPublic,
      reconciliation: {
        ok: reconciliationDelta === 0n,
        delta: reconciliationDelta.toString(),
        deltaUsd: unitsToUsd(reconciliationDelta),
        grossSaleUnits: imputed.grossSaleUnits,
        companyPayoutUnits: imputed.companyPayoutUnits,
        openingCustomerFloatUnits: openingFloatUnits.toString(),
        closingCustomerFloatUnits: closingFloatUnits.toString(),
        deltaCustomerFloatUnits: deltaFloat.toString(),
        operatingProfitUnits: pnl.operatingProfitUnits,
        openingFloatSource: openingFloat.source,
      },
      unitFlow: memo,
      /**
       * Recorded fiat journal. Audit-only under pure imputation: revenue now
       * comes from unit flow, so counting these rows too would double count.
       */
      cash: { ...cash, recordedOnly: true as const },
    }
  },
}
