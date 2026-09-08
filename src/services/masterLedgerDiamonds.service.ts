import { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'
import { unitsToUsd } from '../utils/points-currency'
import { ledgerAccountRoleService, type HouseAccounts } from './ledgerAccountRole.service'
import { resolveLedgerPeriod, type LedgerGrain } from './masterLedger.service'

/**
 * Per-UTC-day diamond report.
 *
 * Every figure comes from the DIAMOND legs in `coin_ledger_entries`, split by whether the
 * wallet belongs to a registered house account. The company's diamond profit is the house
 * edge — bets absorbed less wins and refunds paid — measured from settlement legs rather
 * than the house balance, so admin top-ups never read as profit. See `master-ledger-flow.md`.
 */

/** `created_at` is `timestamp without time zone` holding UTC, so `::date` is the UTC day. */
type DailyFlowRow = {
  day: Date
  tx_type: string
  direction: string
  is_house: boolean
  units: bigint
  cnt: bigint
}

export type DiamondDailyRow = {
  /** UTC day, `YYYY-MM-DD`. */
  date: string

  /** Diamonds users staked into games — the day's diamond consumption. */
  wageredUnits: string
  wageredUsd: string
  /** Diamonds the house paid out as wins. */
  wonByUsersUnits: string
  wonByUsersUsd: string
  /** What those wins cost the company in USD — same figure as `wonByUsersUsd`, named for the P&L read. */
  usdSpentOnUserWins: string
  /** Diamonds handed back on cancelled/voided rounds. */
  refundedUnits: string
  refundedUsd: string

  /** Company diamond profit for the day: wagered − won − refunded. May be negative. */
  profitUnits: string
  /** The same profit in USD at 10,000 units = $1. */
  profitUsd: string

  /** Coins converted into diamonds (users buying in). */
  boughtUnits: string
  boughtUsd: string
  /** Diamonds converted back into coins — returned to the platform, 1:1, never revenue. */
  redeemedUnits: string
  redeemedUsd: string

  /** Admin `GAME_ADJUSTMENT` / `ADJUSTMENT` on DIAMOND wallets. Inventory moves, not profit. */
  adminMintedUnits: string
  adminBurnedUnits: string

  /** Settled game legs on the house side that day. */
  roundLegCount: number

  /** Closing stock at the end of the day, carried forward from the opening balance. */
  closingUserHeldUnits: string
  closingUserHeldUsd: string
  closingHouseHeldUnits: string
  closingHouseHeldUsd: string
}

export type DiamondDailyReport = {
  period: { grain: LedgerGrain; from: string; to: string }
  gameHouseConfigured: boolean
  days: DiamondDailyRow[]
  totals: {
    wageredUnits: string
    wageredUsd: string
    wonByUsersUnits: string
    wonByUsersUsd: string
    usdSpentOnUserWins: string
    refundedUnits: string
    refundedUsd: string
    profitUnits: string
    profitUsd: string
    boughtUnits: string
    boughtUsd: string
    redeemedUnits: string
    redeemedUsd: string
    adminMintedUnits: string
    adminBurnedUnits: string
    roundLegCount: number
    /** Share of staked diamonds the company kept, in basis points. Null when nothing was staked. */
    holdRateBp: number | null
  }
  openingUserHeldUnits: string
  openingHouseHeldUnits: string
}

const ADMIN_TX = ['ADJUSTMENT', 'GAME_ADJUSTMENT']

function houseArray(house: HouseAccounts): Prisma.Sql {
  const ids = [...house.allIds]
  if (ids.length === 0) return Prisma.sql`ARRAY[]::uuid[]`
  return Prisma.sql`ARRAY[${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]`
}

/** UTC `YYYY-MM-DD` for a Date, without touching the local timezone. */
function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Every UTC day in `[from, to)`, so quiet days still appear as zero rows. */
function enumerateDays(from: Date, to: Date): string[] {
  const days: string[] = []
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 0, 0, 0, 0),
  )
  while (cursor.getTime() < to.getTime()) {
    days.push(utcDateKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return days
}

type Bucket = {
  wagered: bigint
  won: bigint
  refunded: bigint
  bought: bigint
  redeemed: bigint
  adminMinted: bigint
  adminBurned: bigint
  roundLegCount: number
  /** Net diamond change on customer and house wallets, for carrying stock forward. */
  userNet: bigint
  houseNet: bigint
}

function emptyBucket(): Bucket {
  return {
    wagered: 0n,
    won: 0n,
    refunded: 0n,
    bought: 0n,
    redeemed: 0n,
    adminMinted: 0n,
    adminBurned: 0n,
    roundLegCount: 0,
    userNet: 0n,
    houseNet: 0n,
  }
}

export const masterLedgerDiamondsService = {
  async dailyReport(params: {
    from?: Date
    to?: Date
    grain?: LedgerGrain
    houseArg?: HouseAccounts
  }): Promise<DiamondDailyReport> {
    const period = resolveLedgerPeriod({
      from: params.from,
      to: params.to,
      grain: params.grain,
    })
    const house = params.houseArg ?? (await ledgerAccountRoleService.getHouseAccounts())
    const houseIds = houseArray(house)

    const [flows, opening] = await Promise.all([
      prismaRead.$queryRaw<DailyFlowRow[]>(Prisma.sql`
        SELECT e.created_at::date AS day,
               e.tx_type::text AS tx_type,
               e.direction::text AS direction,
               (w.user_id = ANY(${houseIds})) AS is_house,
               COALESCE(SUM(e.amount), 0)::bigint AS units,
               COUNT(*)::bigint AS cnt
        FROM coin_ledger_entries e
        INNER JOIN wallets w ON w.id = e.wallet_id
        WHERE w.currency_type = 'DIAMOND'
          AND e.created_at >= ${period.from}
          AND e.created_at < ${period.to}
        GROUP BY 1, 2, 3, 4
      `),
      // Stock carried into the window, so closing balances are absolute rather than
      // relative to the period.
      prismaRead.$queryRaw<{ is_house: boolean; units: bigint }[]>(Prisma.sql`
        SELECT (w.user_id = ANY(${houseIds})) AS is_house,
               COALESCE(
                 SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END),
                 0
               )::bigint AS units
        FROM coin_ledger_entries e
        INNER JOIN wallets w ON w.id = e.wallet_id
        WHERE w.currency_type = 'DIAMOND'
          AND e.created_at < ${period.from}
        GROUP BY 1
      `),
    ])

    const byDay = new Map<string, Bucket>()
    const bucketFor = (key: string): Bucket => {
      let b = byDay.get(key)
      if (!b) {
        b = emptyBucket()
        byDay.set(key, b)
      }
      return b
    }

    for (const row of flows) {
      const b = bucketFor(utcDateKey(row.day))
      const units = BigInt(row.units ?? 0)
      const signed = row.direction === 'CREDIT' ? units : -units
      if (row.is_house) b.houseNet += signed
      else b.userNet += signed

      // House legs carry the settlement totals; the user legs mirror them exactly, so
      // reading one side only keeps every figure single-counted.
      if (row.is_house) {
        if (row.tx_type === 'GAME_WAGER_IN') {
          b.wagered += units
          b.roundLegCount += Number(row.cnt)
        } else if (row.tx_type === 'GAME_RESULT_OUT') {
          b.won += units
          b.roundLegCount += Number(row.cnt)
        } else if (row.tx_type === 'GAME_REFUND_OUT') {
          b.refunded += units
          b.roundLegCount += Number(row.cnt)
        }
      }

      if (row.tx_type === 'DIAMOND_PURCHASE_IN') b.bought += units
      else if (row.tx_type === 'DIAMOND_REDEEM_OUT') b.redeemed += units
      else if (ADMIN_TX.includes(row.tx_type)) {
        if (row.direction === 'CREDIT') b.adminMinted += units
        else b.adminBurned += units
      }
    }

    let userHeld = 0n
    let houseHeld = 0n
    for (const row of opening) {
      if (row.is_house) houseHeld = BigInt(row.units ?? 0)
      else userHeld = BigInt(row.units ?? 0)
    }
    const openingUserHeld = userHeld
    const openingHouseHeld = houseHeld

    const totals = emptyBucket()
    const days: DiamondDailyRow[] = []

    for (const date of enumerateDays(period.from, period.to)) {
      const b = byDay.get(date) ?? emptyBucket()
      userHeld += b.userNet
      houseHeld += b.houseNet

      const profit = b.wagered - b.won - b.refunded

      totals.wagered += b.wagered
      totals.won += b.won
      totals.refunded += b.refunded
      totals.bought += b.bought
      totals.redeemed += b.redeemed
      totals.adminMinted += b.adminMinted
      totals.adminBurned += b.adminBurned
      totals.roundLegCount += b.roundLegCount

      days.push({
        date,
        wageredUnits: b.wagered.toString(),
        wageredUsd: unitsToUsd(b.wagered),
        wonByUsersUnits: b.won.toString(),
        wonByUsersUsd: unitsToUsd(b.won),
        usdSpentOnUserWins: unitsToUsd(b.won),
        refundedUnits: b.refunded.toString(),
        refundedUsd: unitsToUsd(b.refunded),
        profitUnits: profit.toString(),
        profitUsd: unitsToUsd(profit),
        boughtUnits: b.bought.toString(),
        boughtUsd: unitsToUsd(b.bought),
        redeemedUnits: b.redeemed.toString(),
        redeemedUsd: unitsToUsd(b.redeemed),
        adminMintedUnits: b.adminMinted.toString(),
        adminBurnedUnits: b.adminBurned.toString(),
        roundLegCount: b.roundLegCount,
        closingUserHeldUnits: userHeld.toString(),
        closingUserHeldUsd: unitsToUsd(userHeld),
        closingHouseHeldUnits: houseHeld.toString(),
        closingHouseHeldUsd: unitsToUsd(houseHeld),
      })
    }

    const totalProfit = totals.wagered - totals.won - totals.refunded

    return {
      period: {
        grain: period.grain,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      gameHouseConfigured: house.gameHouseIds.size > 0,
      days,
      totals: {
        wageredUnits: totals.wagered.toString(),
        wageredUsd: unitsToUsd(totals.wagered),
        wonByUsersUnits: totals.won.toString(),
        wonByUsersUsd: unitsToUsd(totals.won),
        usdSpentOnUserWins: unitsToUsd(totals.won),
        refundedUnits: totals.refunded.toString(),
        refundedUsd: unitsToUsd(totals.refunded),
        profitUnits: totalProfit.toString(),
        profitUsd: unitsToUsd(totalProfit),
        boughtUnits: totals.bought.toString(),
        boughtUsd: unitsToUsd(totals.bought),
        redeemedUnits: totals.redeemed.toString(),
        redeemedUsd: unitsToUsd(totals.redeemed),
        adminMintedUnits: totals.adminMinted.toString(),
        adminBurnedUnits: totals.adminBurned.toString(),
        roundLegCount: totals.roundLegCount,
        holdRateBp: totals.wagered === 0n ? null : Number((totalProfit * 10000n) / totals.wagered),
      },
      openingUserHeldUnits: openingUserHeld.toString(),
      openingHouseHeldUnits: openingHouseHeld.toString(),
    }
  },
}
