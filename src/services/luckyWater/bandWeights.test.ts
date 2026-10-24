import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BAND_WEIGHTS_V1,
  DEFAULT_ECONOMICS_V1,
  DEFAULT_TIERS_V1,
  LuckyWeightsError,
  assertSelfGiftGuard,
  computeAllBandEvBp,
  computeBandEvBp,
  selfGiftGuardMarginBp,
  sumBandWeights,
  validateBandWeights,
  type BandWeightsByBand,
} from './bandWeights'

const econ = {
  rBp: DEFAULT_ECONOMICS_V1.rBp,
  hBp: DEFAULT_ECONOMICS_V1.hostShareBp,
  aBp: 0,
  vMaxBp: DEFAULT_ECONOMICS_V1.vMaxBp,
  safetyMarginBp: DEFAULT_ECONOMICS_V1.safetyMarginBp,
  minGapBp: DEFAULT_ECONOMICS_V1.minGapBp,
}

const clone = (): BandWeightsByBand => JSON.parse(JSON.stringify(DEFAULT_BAND_WEIGHTS_V1))

describe('luckyWater bandWeights v1', () => {
  it('every band sums to 10000', () => {
    for (const band of Object.values(DEFAULT_BAND_WEIGHTS_V1)) expect(sumBandWeights(band)).toBe(10_000)
  })

  it('computes the specified EVs in bp', () => {
    const ev = computeAllBandEvBp(DEFAULT_BAND_WEIGHTS_V1)
    expect(ev).toEqual({ critical: 5500, low: 7300, normal: 9275, high: 9450 })
    expect(computeBandEvBp(DEFAULT_BAND_WEIGHTS_V1.high)).toBe(9450)
  })

  it('satisfies ordering EV_c < EV_l < r < EV_n < EV_h and EV_n - r >= 50bp', () => {
    const ev = computeAllBandEvBp(DEFAULT_BAND_WEIGHTS_V1)
    expect(ev.critical).toBeLessThan(ev.low)
    expect(ev.low).toBeLessThan(econ.rBp)
    expect(econ.rBp).toBeLessThan(ev.normal)
    expect(ev.normal).toBeLessThan(ev.high)
    expect(ev.normal - econ.rBp).toBeGreaterThanOrEqual(50)
    expect(ev.normal - econ.rBp).toBe(75)
  })

  it('passes F2 (9450 + 400 = 9850 < 9900)', () => {
    expect(selfGiftGuardMarginBp({ evHighBp: 9450, hBp: 400, aBp: 0, vMaxBp: 10_000, safetyMarginBp: 100 })).toBe(50)
    expect(() => assertSelfGiftGuard({ evHighBp: 9450, hBp: 400, vMaxBp: 10_000, safetyMarginBp: 100 })).not.toThrow()
  })

  it('validateBandWeights accepts the v1 table and returns EVs', () => {
    expect(validateBandWeights(DEFAULT_BAND_WEIGHTS_V1, econ).normal).toBe(9275)
  })

  it('F2 is strict: equality fails', () => {
    // 9500 + 400 = 9900 == 10000 - 100 -> must throw
    expect(() => assertSelfGiftGuard({ evHighBp: 9500, hBp: 400, vMaxBp: 10_000, safetyMarginBp: 100 })).toThrow(
      LuckyWeightsError,
    )
  })

  it('F2 counts agency commission and v_max', () => {
    expect(() => assertSelfGiftGuard({ evHighBp: 9450, hBp: 400, aBp: 100, vMaxBp: 10_000, safetyMarginBp: 100 })).toThrow(
      LuckyWeightsError,
    )
    expect(() => assertSelfGiftGuard({ evHighBp: 9450, hBp: 400, vMaxBp: 12_500, safetyMarginBp: 100 })).toThrow(
      LuckyWeightsError,
    )
    expect(() => assertSelfGiftGuard({ evHighBp: 9450, hBp: 400, vMaxBp: 10_000, safetyMarginBp: 100 })).not.toThrow()
  })

  it('rejects bands that do not sum to 10000', () => {
    const w = clone()
    w.high.miss += 1
    expect(() => validateBandWeights(w, econ)).toThrow(/sum/)
  })

  it('rejects a raised high band (breaks F2)', () => {
    const w = clone()
    w.high.miss -= 100
    w.high.jackpot += 100 // +100*10 = +1000 bp... EV way past guard
    expect(() => validateBandWeights(w, econ)).toThrow(LuckyWeightsError)
  })

  it('rejects EV_normal - r below min gap', () => {
    const w = clone()
    // shift 10bp of weight from equal(1x) to half(0.5x) => EV_normal drops by 5bp... use larger shift
    w.normal.equal -= 150
    w.normal.half += 150 // -75bp => EV 9200 == r
    expect(() => validateBandWeights(w, econ)).toThrow(/r\(9200\)/)
  })

  it('rejects jackpot in critical/low bands', () => {
    const w = clone()
    w.critical.equal -= 100
    w.critical.jackpot += 100
    expect(() => validateBandWeights(w, econ)).toThrow(/critical/)
  })

  it('tier defaults are contiguous and floor = L0/5', () => {
    expect(DEFAULT_TIERS_V1.map((t) => t.tierId)).toEqual(['T100', 'T500', 'T2K', 'T10K', 'T50K'])
    for (let i = 1; i < DEFAULT_TIERS_V1.length; i++) {
      expect(DEFAULT_TIERS_V1[i].priceMin).toBe((DEFAULT_TIERS_V1[i - 1].priceMax as number) + 1)
    }
    expect(DEFAULT_TIERS_V1[4].priceMax).toBeNull()
    for (const t of DEFAULT_TIERS_V1) expect(t.floor * 5n).toBe(t.l0)
  })
})
