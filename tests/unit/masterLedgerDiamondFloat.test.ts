import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Liability-side double-count guards.
 *
 * Diamonds ride `coin_ledger_entries` alongside COIN/TRADING_COIN, so the two ways to get
 * this wrong are (a) counting a diamond wallet twice, and (b) counting a diamond purchase
 * as new float when it only moved value between two wallets of the same user.
 */

const queryRaw = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {},
  prismaRead: {
    get $queryRaw() {
      return queryRaw
    },
  },
}))

import { computeFloatAt } from '../../src/services/masterLedger.service'
import type { HouseAccounts } from '../../src/services/ledgerAccountRole.service'

const HOUSE_ID = 'house-1'
const USER_ID = 'user-1'

function houseAccounts(): HouseAccounts {
  return {
    treasuryIds: new Set<string>(),
    companyAgencyIds: new Set<string>(),
    gameHouseIds: new Set([HOUSE_ID]),
    allIds: new Set([HOUSE_ID]),
  }
}

type WalletRow = { currency: string; is_agent: boolean; user_id: string; balance: bigint }

function wallet(currency: string, user_id: string, balance: bigint, is_agent = false): WalletRow {
  return { currency, user_id, balance, is_agent }
}

/**
 * `loadWalletBalancesAt` reads per-wallet `balance_after` from coin + point ledgers;
 * `ledgerNetAt` reads grouped credit/debit totals (fdc1018: one grouped scan per ledger
 * instead of ~70 aggregates). Route each $queryRaw by the SQL it runs, not by call order,
 * because both run concurrently under Promise.all.
 */
function sqlText(q: unknown): string {
  const o = q as { sql?: string; text?: string; strings?: string[] }
  return o.sql ?? o.text ?? o.strings?.join('?') ?? ''
}

function mockLedger(coinRows: WalletRow[], pointRows: WalletRow[], ledgerNet: bigint) {
  queryRaw.mockReset()
  queryRaw.mockImplementation(async (q: unknown) => {
    const sql = sqlText(q)
    const isPoint = sql.includes('point_ledger_entries')
    if (sql.includes('balance_after')) return isPoint ? pointRows : coinRows
    if (sql.includes('GROUP BY')) {
      // Express the whole net as one customer coin credit; the identity only reads the sum.
      return isPoint
        ? []
        : [{ tx_type: 'COIN_PURCHASE', direction: 'CREDIT', currency: 'COIN', is_house: false, promo: false, units: ledgerNet }]
    }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`)
  })
}

// ledgerTotals memoizes by timestamp; give every computeFloatAt call its own instant.
let tick = Date.UTC(2026, 8, 1)
const nextAt = () => new Date((tick += 1000))

describe('computeFloatAt — diamond liability', () => {
  beforeEach(() => {
    queryRaw.mockReset()
  })

  it('counts a user holding coins and diamonds once each, not twice', async () => {
    mockLedger(
      [wallet('COIN', USER_ID, 3_000n), wallet('DIAMOND', USER_ID, 2_000n)],
      [],
      5_000n,
    )
    const b = await computeFloatAt(nextAt(), houseAccounts())

    expect(b.customerCoins).toBe(3_000n)
    expect(b.customerDiamonds).toBe(2_000n)
    expect(b.customerTotal).toBe(5_000n)
    expect(b.identityDelta).toBe(0n)
  })

  it('treats buying diamonds as float-neutral, not as new liability', async () => {
    // Before: 10,000 coins. After buying 4,000 diamonds: 6,000 coins + 4,000 diamonds.
    mockLedger([wallet('COIN', USER_ID, 10_000n)], [], 10_000n)
    const before = await computeFloatAt(nextAt(), houseAccounts())

    mockLedger(
      [wallet('COIN', USER_ID, 6_000n), wallet('DIAMOND', USER_ID, 4_000n)],
      [],
      10_000n,
    )
    const after = await computeFloatAt(nextAt(), houseAccounts())

    expect(after.customerTotal).toBe(before.customerTotal)
    expect(after.identityDelta).toBe(0n)
  })

  it('keeps game-house diamonds out of customer float', async () => {
    mockLedger(
      [wallet('DIAMOND', USER_ID, 1_000n), wallet('DIAMOND', HOUSE_ID, 9_000n)],
      [],
      10_000n,
    )
    const b = await computeFloatAt(nextAt(), houseAccounts())

    expect(b.customerDiamonds).toBe(1_000n)
    expect(b.customerTotal).toBe(1_000n)
    expect(b.houseDiamonds).toBe(9_000n)
    expect(b.houseTotal).toBe(9_000n)
    // House inventory is not a liability, but it is still inside the identity.
    expect(b.identityDelta).toBe(0n)
  })

  it('moves a wager from customer float to house inventory without changing the total', async () => {
    mockLedger([wallet('DIAMOND', USER_ID, 5_000n)], [], 5_000n)
    const before = await computeFloatAt(nextAt(), houseAccounts())

    mockLedger(
      [wallet('DIAMOND', USER_ID, 2_000n), wallet('DIAMOND', HOUSE_ID, 3_000n)],
      [],
      5_000n,
    )
    const after = await computeFloatAt(nextAt(), houseAccounts())

    expect(before.customerTotal).toBe(5_000n)
    expect(after.customerTotal).toBe(2_000n)
    expect(after.houseTotal).toBe(3_000n)
    expect(after.customerTotal + after.houseTotal).toBe(before.customerTotal + before.houseTotal)
    expect(after.identityDelta).toBe(0n)
  })

  it('regression: a diamond wallet outside the scan breaks the identity by its balance', async () => {
    // What the bug looked like — ledger net includes the diamond credit, the scan does not.
    mockLedger([wallet('COIN', USER_ID, 0n)], [], 6_120n)
    const b = await computeFloatAt(nextAt(), houseAccounts())
    expect(b.identityDelta).toBe(-6_120n)

    // With the diamond wallet scanned, the identity closes.
    mockLedger([wallet('COIN', USER_ID, 0n), wallet('DIAMOND', HOUSE_ID, 6_120n)], [], 6_120n)
    const fixed = await computeFloatAt(nextAt(), houseAccounts())
    expect(fixed.identityDelta).toBe(0n)
  })

  it('splits customer points by agent flag without diamonds leaking in', async () => {
    mockLedger(
      [wallet('DIAMOND', USER_ID, 100n)],
      [wallet('POINT', USER_ID, 700n), wallet('POINT', 'agent-1', 200n, true)],
      1_000n,
    )
    const b = await computeFloatAt(nextAt(), houseAccounts())

    expect(b.customerHostPoints).toBe(700n)
    expect(b.customerAgencyPoints).toBe(200n)
    expect(b.customerDiamonds).toBe(100n)
    expect(b.customerTotal).toBe(1_000n)
    expect(b.identityDelta).toBe(0n)
  })
})
