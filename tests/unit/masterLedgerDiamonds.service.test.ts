import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryRaw = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: {},
  prismaRead: {
    get $queryRaw() {
      return queryRaw
    },
  },
}))

vi.mock('../../src/services/ledgerAccountRole.service', () => ({
  ledgerAccountRoleService: {
    getHouseAccounts: vi.fn(async () => ({
      treasuryIds: new Set<string>(),
      companyAgencyIds: new Set<string>(),
      gameHouseIds: new Set(['house-1']),
      allIds: new Set(['house-1']),
    })),
  },
}))

import { masterLedgerDiamondsService } from '../../src/services/masterLedgerDiamonds.service'

type Row = {
  day: Date
  tx_type: string
  direction: string
  is_house: boolean
  units: bigint
  cnt: bigint
}

function row(
  day: string,
  tx_type: string,
  direction: 'CREDIT' | 'DEBIT',
  is_house: boolean,
  units: bigint,
  cnt = 1n,
): Row {
  return { day: new Date(`${day}T00:00:00.000Z`), tx_type, direction, is_house, units, cnt }
}

/** First $queryRaw call is the daily flows, second is the opening balance. */
function mockQueries(flows: Row[], opening: { is_house: boolean; units: bigint }[] = []) {
  queryRaw.mockReset()
  queryRaw.mockImplementationOnce(async () => flows).mockImplementationOnce(async () => opening)
}

const PERIOD = {
  from: new Date(Date.UTC(2026, 8, 1)),
  to: new Date(Date.UTC(2026, 8, 4)),
  grain: 'custom' as const,
}

describe('masterLedgerDiamondsService.dailyReport', () => {
  beforeEach(() => queryRaw.mockReset())

  it('emits one row per UTC day including quiet days', async () => {
    mockQueries([])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.days.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(r.totals.wageredUnits).toBe('0')
    expect(r.totals.holdRateBp).toBeNull()
  })

  it('books a losing bet as company profit and a win as a loss', async () => {
    mockQueries([
      // 10,000 wagered, 4,000 paid back out as a win.
      row('2026-09-01', 'GAME_WAGER_OUT', 'DEBIT', false, 10_000n),
      row('2026-09-01', 'GAME_WAGER_IN', 'CREDIT', true, 10_000n),
      row('2026-09-02', 'GAME_RESULT_OUT', 'DEBIT', true, 4_000n),
      row('2026-09-02', 'GAME_RESULT_IN', 'CREDIT', false, 4_000n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)

    const [d1, d2] = r.days
    expect(d1.wageredUnits).toBe('10000')
    expect(d1.profitUnits).toBe('10000')
    expect(d1.profitUsd).toBe('1.00')

    expect(d2.wonByUsersUnits).toBe('4000')
    expect(d2.usdSpentOnUserWins).toBe('0.40')
    expect(d2.profitUnits).toBe('-4000')

    expect(r.totals.profitUnits).toBe('6000')
    expect(r.totals.profitUsd).toBe('0.60')
    // 6,000 kept of 10,000 staked = 60%.
    expect(r.totals.holdRateBp).toBe(6000)
  })

  it('counts settlement once, from the house leg only', async () => {
    mockQueries([
      row('2026-09-01', 'GAME_WAGER_OUT', 'DEBIT', false, 5_000n, 3n),
      row('2026-09-01', 'GAME_WAGER_IN', 'CREDIT', true, 5_000n, 3n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.days[0].wageredUnits).toBe('5000')
    expect(r.days[0].roundLegCount).toBe(3)
  })

  it('ignores the user legs entirely, so nothing is counted twice', async () => {
    // Only the user side of a round. These tx types must contribute nothing on their own —
    // if they ever did, every game figure would be double what it should be.
    mockQueries([
      row('2026-09-01', 'GAME_WAGER_OUT', 'DEBIT', false, 10_000n),
      row('2026-09-01', 'GAME_RESULT_IN', 'CREDIT', false, 4_000n),
      row('2026-09-01', 'GAME_REFUND_IN', 'CREDIT', false, 1_000n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)

    expect(r.totals.wageredUnits).toBe('0')
    expect(r.totals.wonByUsersUnits).toBe('0')
    expect(r.totals.refundedUnits).toBe('0')
    expect(r.totals.profitUnits).toBe('0')
    expect(r.totals.roundLegCount).toBe(0)
    // They still move customer stock, which is the one thing the user leg is read for.
    expect(r.days[0].closingUserHeldUnits).toBe('-5000')
  })

  it('does not let a house-role user leg inflate settlement', async () => {
    // A GAME_HOUSE account that also plays would emit user-leg tx types on a house wallet.
    // Those must not be read as settlement either — only the three house-leg types count.
    mockQueries([
      row('2026-09-01', 'GAME_WAGER_IN', 'CREDIT', true, 2_000n),
      row('2026-09-01', 'GAME_WAGER_OUT', 'DEBIT', true, 2_000n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.totals.wageredUnits).toBe('2000')
    expect(r.totals.profitUnits).toBe('2000')
  })

  it('treats conversion as float-neutral and never as profit', async () => {
    mockQueries([
      row('2026-09-01', 'DIAMOND_PURCHASE_IN', 'CREDIT', false, 20_000n),
      row('2026-09-02', 'DIAMOND_REDEEM_OUT', 'DEBIT', false, 7_000n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.days[0].boughtUnits).toBe('20000')
    expect(r.days[1].redeemedUnits).toBe('7000')
    expect(r.totals.profitUnits).toBe('0')
  })

  it('treats seeding the game house as inventory, not profit', async () => {
    mockQueries([row('2026-09-01', 'GAME_ADJUSTMENT', 'CREDIT', true, 6_120n)])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.days[0].adminMintedUnits).toBe('6120')
    expect(r.days[0].profitUnits).toBe('0')
    // Inventory still lands on the house stock line.
    expect(r.days[0].closingHouseHeldUnits).toBe('6120')
    expect(r.days[0].closingUserHeldUnits).toBe('0')
  })

  it('carries stock forward across days from the opening balance', async () => {
    mockQueries(
      [
        row('2026-09-01', 'DIAMOND_PURCHASE_IN', 'CREDIT', false, 1_000n),
        row('2026-09-02', 'GAME_WAGER_OUT', 'DEBIT', false, 400n),
        row('2026-09-02', 'GAME_WAGER_IN', 'CREDIT', true, 400n),
      ],
      [
        { is_house: false, units: 500n },
        { is_house: true, units: 900n },
      ],
    )
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.openingUserHeldUnits).toBe('500')
    expect(r.openingHouseHeldUnits).toBe('900')

    expect(r.days[0].closingUserHeldUnits).toBe('1500')
    expect(r.days[1].closingUserHeldUnits).toBe('1100')
    expect(r.days[1].closingHouseHeldUnits).toBe('1300')
    // Quiet day holds the previous close rather than resetting.
    expect(r.days[2].closingUserHeldUnits).toBe('1100')
  })

  it('reports a negative day when payouts exceed stakes', async () => {
    mockQueries([
      row('2026-09-01', 'GAME_WAGER_IN', 'CREDIT', true, 1_000n),
      row('2026-09-01', 'GAME_RESULT_OUT', 'DEBIT', true, 9_000n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.days[0].profitUnits).toBe('-8000')
    expect(r.days[0].profitUsd).toBe('-0.80')
    expect(r.totals.holdRateBp).toBe(-80000)
  })

  it('counts refunds as money returned to users, like a win', async () => {
    mockQueries([
      row('2026-09-01', 'GAME_WAGER_IN', 'CREDIT', true, 3_000n),
      row('2026-09-01', 'GAME_REFUND_OUT', 'DEBIT', true, 3_000n),
    ])
    const r = await masterLedgerDiamondsService.dailyReport(PERIOD)
    expect(r.days[0].refundedUnits).toBe('3000')
    expect(r.days[0].profitUnits).toBe('0')
  })
})
