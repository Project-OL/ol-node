import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Liability-side double-count guards.
 *
 * Diamonds ride `coin_ledger_entries` alongside COIN/TRADING_COIN, so the two ways to get
 * this wrong are (a) counting a diamond wallet twice, and (b) counting a diamond purchase
 * as new float when it only moved value between two wallets of the same user.
 */

const queryRaw = vi.fn()
const coinAggregate = vi.fn()
const pointAggregate = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {},
  prismaRead: {
    get $queryRaw() {
      return queryRaw
    },
    coinLedgerEntry: {
      get aggregate() {
        return coinAggregate
      },
    },
    pointLedgerEntry: {
      get aggregate() {
        return pointAggregate
      },
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
 * `loadWalletBalancesAt` issues the coin-side query then the point-side query;
 * `ledgerNetAt` then runs coin credit/debit and point credit/debit aggregates.
 */
function mockLedger(coinRows: WalletRow[], pointRows: WalletRow[], ledgerNet: bigint) {
  queryRaw.mockReset()
  coinAggregate.mockReset()
  pointAggregate.mockReset()
  queryRaw.mockImplementationOnce(async () => coinRows).mockImplementationOnce(async () => pointRows)
  // Express the whole net as a single coin credit; the identity only reads the sum.
  coinAggregate
    .mockImplementationOnce(async () => ({ _sum: { amount: ledgerNet } }))
    .mockImplementationOnce(async () => ({ _sum: { amount: 0n } }))
  pointAggregate
    .mockImplementationOnce(async () => ({ _sum: { amount: 0n } }))
    .mockImplementationOnce(async () => ({ _sum: { amount: 0n } }))
}

describe('computeFloatAt — diamond liability', () => {
  beforeEach(() => {
    queryRaw.mockReset()
    coinAggregate.mockReset()
    pointAggregate.mockReset()
  })

  it('counts a user holding coins and diamonds once each, not twice', async () => {
    mockLedger(
      [wallet('COIN', USER_ID, 3_000n), wallet('DIAMOND', USER_ID, 2_000n)],
      [],
      5_000n,
    )
    const b = await computeFloatAt(new Date(), houseAccounts())

    expect(b.customerCoins).toBe(3_000n)
    expect(b.customerDiamonds).toBe(2_000n)
    expect(b.customerTotal).toBe(5_000n)
    expect(b.identityDelta).toBe(0n)
  })

  it('treats buying diamonds as float-neutral, not as new liability', async () => {
    // Before: 10,000 coins. After buying 4,000 diamonds: 6,000 coins + 4,000 diamonds.
    mockLedger([wallet('COIN', USER_ID, 10_000n)], [], 10_000n)
    const before = await computeFloatAt(new Date(), houseAccounts())

    mockLedger(
      [wallet('COIN', USER_ID, 6_000n), wallet('DIAMOND', USER_ID, 4_000n)],
      [],
      10_000n,
    )
    const after = await computeFloatAt(new Date(), houseAccounts())

    expect(after.customerTotal).toBe(before.customerTotal)
    expect(after.identityDelta).toBe(0n)
  })

  it('keeps game-house diamonds out of customer float', async () => {
    mockLedger(
      [wallet('DIAMOND', USER_ID, 1_000n), wallet('DIAMOND', HOUSE_ID, 9_000n)],
      [],
      10_000n,
    )
    const b = await computeFloatAt(new Date(), houseAccounts())

    expect(b.customerDiamonds).toBe(1_000n)
    expect(b.customerTotal).toBe(1_000n)
    expect(b.houseDiamonds).toBe(9_000n)
    expect(b.houseTotal).toBe(9_000n)
    // House inventory is not a liability, but it is still inside the identity.
    expect(b.identityDelta).toBe(0n)
  })

  it('moves a wager from customer float to house inventory without changing the total', async () => {
    mockLedger([wallet('DIAMOND', USER_ID, 5_000n)], [], 5_000n)
    const before = await computeFloatAt(new Date(), houseAccounts())

    mockLedger(
      [wallet('DIAMOND', USER_ID, 2_000n), wallet('DIAMOND', HOUSE_ID, 3_000n)],
      [],
      5_000n,
    )
    const after = await computeFloatAt(new Date(), houseAccounts())

    expect(before.customerTotal).toBe(5_000n)
    expect(after.customerTotal).toBe(2_000n)
    expect(after.houseTotal).toBe(3_000n)
    expect(after.customerTotal + after.houseTotal).toBe(before.customerTotal + before.houseTotal)
    expect(after.identityDelta).toBe(0n)
  })

  it('regression: a diamond wallet outside the scan breaks the identity by its balance', async () => {
    // What the bug looked like — ledger net includes the diamond credit, the scan does not.
    mockLedger([wallet('COIN', USER_ID, 0n)], [], 6_120n)
    const b = await computeFloatAt(new Date(), houseAccounts())
    expect(b.identityDelta).toBe(-6_120n)

    // With the diamond wallet scanned, the identity closes.
    mockLedger([wallet('COIN', USER_ID, 0n), wallet('DIAMOND', HOUSE_ID, 6_120n)], [], 6_120n)
    const fixed = await computeFloatAt(new Date(), houseAccounts())
    expect(fixed.identityDelta).toBe(0n)
  })

  it('splits customer points by agent flag without diamonds leaking in', async () => {
    mockLedger(
      [wallet('DIAMOND', USER_ID, 100n)],
      [wallet('POINT', USER_ID, 700n), wallet('POINT', 'agent-1', 200n, true)],
      1_000n,
    )
    const b = await computeFloatAt(new Date(), houseAccounts())

    expect(b.customerHostPoints).toBe(700n)
    expect(b.customerAgencyPoints).toBe(200n)
    expect(b.customerDiamonds).toBe(100n)
    expect(b.customerTotal).toBe(1_000n)
    expect(b.identityDelta).toBe(0n)
  })
})
