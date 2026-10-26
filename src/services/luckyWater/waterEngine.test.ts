import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BAND_WEIGHTS_V1, type BandWeightsByBand } from './bandWeights'
import { comboCategory, resolveCategory, singleCategory } from './categoryMap'
import { payloadFingerprint } from './payloadFingerprint'
import {
  OUTCOME_FRACTION,
  bandForWater,
  collapseBreakdown,
  computeInflow,
  drawUnits,
  lambdaBp,
  outcomeFromRoll,
  unitInflowOk,
  type LambdaThresholds,
} from './waterEngine'

const weights: BandWeightsByBand = DEFAULT_BAND_WEIGHTS_V1 as unknown as BandWeightsByBand
const thresholds: LambdaThresholds = { criticalMaxBp: 5_000, lowMaxBp: 10_000, normalMaxBp: 15_000 }

/** randomInt stub: returns the queued rolls in order (ignores min/max). */
function rolls(...vals: number[]): (min: number, max: number) => number {
  let i = 0
  return () => vals[i++]
}

const baseDraw = {
  unitPrice: 100n,
  count: 1,
  weights,
  thresholds,
  l0: 100_000n,
  floor: 20_000n,
  mMax: 10,
  startingWater: 120_000n, // λ = 1.2 -> normal band
  dailyWinCapCoins: 0n,
  priorDailyWon: 0n,
  coolDownActive: false,
}

describe('waterEngine: bands and rolls', () => {
  it('lambdaBp and bandForWater use the three cutoffs', () => {
    expect(lambdaBp(40_000n, 100_000n)).toBe(4_000n)
    expect(bandForWater(40_000n, 100_000n, thresholds)).toBe('critical') // λ 0.4
    expect(bandForWater(70_000n, 100_000n, thresholds)).toBe('low') // λ 0.7
    expect(bandForWater(120_000n, 100_000n, thresholds)).toBe('normal') // λ 1.2
    expect(bandForWater(160_000n, 100_000n, thresholds)).toBe('high') // λ 1.6
  })

  it('outcomeFromRoll walks cumulative normal weights {4000,2600,1850,1250,300}', () => {
    const n = weights.normal
    expect(outcomeFromRoll(n, 0)).toBe('miss')
    expect(outcomeFromRoll(n, 3_999)).toBe('miss')
    expect(outcomeFromRoll(n, 4_000)).toBe('half')
    expect(outcomeFromRoll(n, 6_599)).toBe('half')
    expect(outcomeFromRoll(n, 6_600)).toBe('equal')
    expect(outcomeFromRoll(n, 8_449)).toBe('equal')
    expect(outcomeFromRoll(n, 8_450)).toBe('medium')
    expect(outcomeFromRoll(n, 9_699)).toBe('medium')
    expect(outcomeFromRoll(n, 9_700)).toBe('jackpot')
    expect(outcomeFromRoll(n, 9_999)).toBe('jackpot')
  })

  it('OUTCOME_FRACTION is BigInt-exact: half of 199 floors to 99', () => {
    const half = OUTCOME_FRACTION.half
    expect((199n * half.num) / half.den).toBe(99n)
    expect((100n * OUTCOME_FRACTION.medium.num) / OUTCOME_FRACTION.medium.den).toBe(250n)
    expect((100n * OUTCOME_FRACTION.jackpot.num) / OUTCOME_FRACTION.jackpot.den).toBe(1_000n)
  })
})

describe('waterEngine: drawUnits', () => {
  it('single medium pays 2.5x and leaves the pool correct', () => {
    const r = drawUnits({ ...baseDraw, randomInt: rolls(9_000) })
    expect(r.totalPaid).toBe(250n)
    expect(r.rewards).toEqual([250n])
    expect(r.finalWater).toBe(120_000n + computeInflow(0n, 9_200) - 250n) // inflow added by caller
    expect(r.units[0].downgrade).toBeNull()
    expect(r.bigWin).toBe(false)
  })

  it('single half on an odd price floors (199 -> 99)', () => {
    const r = drawUnits({ ...baseDraw, unitPrice: 199n, randomInt: rolls(5_000) })
    expect(r.totalPaid).toBe(99n)
    expect(resolveCategory({ count: 1, unitPrice: 199n, totalPaid: r.totalPaid })).toBe('SMALL')
  })

  it('single jackpot pays 10x and flags a big win', () => {
    const r = drawUnits({ ...baseDraw, randomInt: rolls(9_800) })
    expect(r.totalPaid).toBe(1_000n)
    expect(r.bigWin).toBe(true)
  })

  it('m_max caps the raw reward (reduce, not a downgrade)', () => {
    const r = drawUnits({ ...baseDraw, mMax: 2, randomInt: rolls(9_800) }) // jackpot raw 1000
    expect(r.totalPaid).toBe(200n) // capped to 2 * 100
    expect(r.units[0].downgrade).toBeNull()
  })

  it('force-misses when a win would take the pool below floor (POOL_FLOOR)', () => {
    // λ = 0.2 -> critical band; an EQUAL (roll 8000) raw-pays 100 but only 50 sits above the floor.
    const r = drawUnits({ ...baseDraw, startingWater: 20_050n, randomInt: rolls(8_000) })
    expect(r.units[0].outcome).toBe('equal')
    expect(r.totalPaid).toBe(0n)
    expect(r.finalWater).toBe(20_050n) // never below floor 20000
    expect(r.units[0].downgrade).toBe('POOL_FLOOR')
  })

  it('force-misses on the daily win cap (USER_CAP)', () => {
    const r = drawUnits({
      ...baseDraw,
      dailyWinCapCoins: 100n,
      priorDailyWon: 0n,
      randomInt: rolls(9_000),
    }) // medium raw 250 > remaining 100
    expect(r.totalPaid).toBe(0n)
    expect(r.units[0].downgrade).toBe('USER_CAP')
  })

  it('force-misses every unit while in cool-down (USER_CAP)', () => {
    const r = drawUnits({
      ...baseDraw,
      count: 2,
      coolDownActive: true,
      randomInt: rolls(9_800, 9_000),
    })
    expect(r.totalPaid).toBe(0n)
    expect(r.units.map((u) => u.downgrade)).toEqual(['USER_CAP', 'USER_CAP'])
  })

  it('combo of independent draws can exceed 2x spend (A1: no 2x combo ceiling)', () => {
    const r = drawUnits({ ...baseDraw, count: 3, randomInt: rolls(9_000, 9_800, 1_000) })
    expect(r.rewards).toEqual([250n, 1_000n, 0n])
    expect(r.totalPaid).toBe(1_250n) // 4.16x of S=300
    expect(r.finalWater).toBe(120_000n - 1_250n)
    expect(r.bigWin).toBe(true)
    expect(resolveCategory({ count: 3, unitPrice: 100n, totalPaid: r.totalPaid })).toBe('WINNER')
  })
})

describe('waterEngine: collapseBreakdown', () => {
  it('N <= 10 is one entry per unit', () => {
    expect(collapseBreakdown([1n, 2n, 3n])).toEqual([1n, 2n, 3n])
  })

  it('N = 25 collapses to 10 groups (first 5 of size 3, rest size 2), sum preserved', () => {
    const per = Array.from({ length: 25 }, () => 10n)
    const out = collapseBreakdown(per)
    expect(out).toHaveLength(10)
    expect(out.slice(0, 5)).toEqual([30n, 30n, 30n, 30n, 30n])
    expect(out.slice(5)).toEqual([20n, 20n, 20n, 20n, 20n])
    expect(out.reduce((a, b) => a + b, 0n)).toBe(250n)
  })

  it('collapse preserves an uneven total', () => {
    const per = Array.from({ length: 23 }, (_, i) => BigInt(i))
    const out = collapseBreakdown(per)
    expect(out).toHaveLength(10)
    expect(out.reduce((a, b) => a + b, 0n)).toBe(per.reduce((a, b) => a + b, 0n))
  })
})

describe('categoryMap: F8', () => {
  it('singles by paid multiplier', () => {
    expect(singleCategory(100n, 0n)).toBe('MISS')
    expect(singleCategory(100n, 50n)).toBe('SMALL') // 0.5x
    expect(singleCategory(100n, 100n)).toBe('EQUAL') // 1x
    expect(singleCategory(100n, 250n)).toBe('MEDIUM') // 2.5x
    expect(singleCategory(100n, 1_000n)).toBe('JACKPOT') // 10x
    expect(singleCategory(199n, 99n)).toBe('SMALL') // floor(0.5x) still SMALL
  })

  it('combos by floor bp of total over spend', () => {
    expect(comboCategory(0n, 300n)).toBe('MISS')
    expect(comboCategory(1n, 1_000_000n)).toBe('MISS') // bp floors to 0
    expect(comboCategory(100n, 300n)).toBe('UNLUCKY') // 3333 bp
    expect(comboCategory(300n, 300n)).toBe('BREAK_EVEN') // 10000 bp (1x)
    expect(comboCategory(1_000n, 300n)).toBe('WINNER') // 33333 bp
  })

  it('combo boundary bp fixtures (7500 / 9500 / 12500)', () => {
    // bp exactly on boundary maps to the higher-or-equal half-open bucket
    const S = 10_000n
    expect(comboCategory(7_499n, S)).toBe('UNLUCKY')
    expect(comboCategory(7_500n, S)).toBe('NORMAL')
    expect(comboCategory(9_499n, S)).toBe('NORMAL')
    expect(comboCategory(9_500n, S)).toBe('BREAK_EVEN')
    expect(comboCategory(12_499n, S)).toBe('BREAK_EVEN')
    expect(comboCategory(12_500n, S)).toBe('WINNER')
  })
})

describe('F9: minimum price for pool inflow', () => {
  it('rejects a price so small inflow would floor to 0', () => {
    // r_bp = 9200 -> need P * 9200 >= 10000 -> P >= 2
    expect(unitInflowOk(1n, 9_200)).toBe(false)
    expect(unitInflowOk(2n, 9_200)).toBe(true)
    expect(computeInflow(1n, 9_200)).toBe(0n)
    expect(computeInflow(2n, 9_200)).toBe(1n)
    expect(computeInflow(100n, 9_200)).toBe(92n)
  })
})

describe('payloadFingerprint: F5', () => {
  it('is deterministic for the same logical send and differs on any field', () => {
    const base = { senderId: 's1', giftId: 'g1', count: 2, receiverId: 'r1' }
    expect(payloadFingerprint(base)).toBe(payloadFingerprint({ ...base }))
    expect(payloadFingerprint(base)).not.toBe(payloadFingerprint({ ...base, count: 3 }))
    expect(payloadFingerprint(base)).not.toBe(payloadFingerprint({ ...base, receiverId: 'r2' }))
    expect(payloadFingerprint({ ...base, receiverId: null })).toHaveLength(64) // sha256 hex
  })
})

describe('no Math.random in luckyWater money code', () => {
  it('no source file under luckyWater/ uses Math.random', () => {
    const dir = __dirname
    const offenders: string[] = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
      if (readFileSync(join(dir, f), 'utf8').includes('Math.random')) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
