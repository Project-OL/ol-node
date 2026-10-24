/**
 * Water-level lucky tiers: band weight tables + economics guards (Phase 2, pure helpers).
 *
 * All values are integer basis points (10000 = 1.0) so validation is exact (no float drift).
 * Design: docs/lucky/WATER_LEVEL_DESIGN.md (§4). Used later by admin config validation and the
 * Phase 3 engine; nothing here touches the DB.
 */

export const LUCKY_TIER_IDS = ['T100', 'T500', 'T2K', 'T10K', 'T50K'] as const
export type LuckyTierId = (typeof LUCKY_TIER_IDS)[number]

export const LUCKY_BANDS = ['critical', 'low', 'normal', 'high'] as const
export type LuckyBand = (typeof LUCKY_BANDS)[number]

export const LUCKY_OUTCOMES = ['miss', 'half', 'equal', 'medium', 'jackpot'] as const
export type LuckyOutcome = (typeof LUCKY_OUTCOMES)[number]

export type BandWeights = Record<LuckyOutcome, number>
export type BandWeightsByBand = Record<LuckyBand, BandWeights>

export const BP = 10_000

/** Reward multiplier of the gift price per outcome, in bp (5000 = 0.5x, 100000 = 10x). */
export const OUTCOME_MULTIPLIER_BP: Readonly<Record<LuckyOutcome, number>> = Object.freeze({
  miss: 0,
  half: 5_000,
  equal: 10_000,
  medium: 25_000,
  jackpot: 100_000,
})

export const WEIGHT_TABLE_ID_V1 = 'wt_v1_2026_10_24'

export const DEFAULT_BAND_WEIGHTS_V1: Readonly<BandWeightsByBand> = Object.freeze({
  critical: { miss: 3000, half: 3000, equal: 4000, medium: 0, jackpot: 0 },
  low: { miss: 3400, half: 2800, equal: 2400, medium: 1400, jackpot: 0 },
  normal: { miss: 4000, half: 2600, equal: 1850, medium: 1250, jackpot: 300 },
  high: { miss: 5200, half: 2100, equal: 1400, medium: 800, jackpot: 500 },
})

export interface LuckyTierDefaults {
  tierId: LuckyTierId
  priceMin: number
  /** null = unbounded */
  priceMax: number | null
  l0: bigint
  floor: bigint
}

export const DEFAULT_TIERS_V1: readonly LuckyTierDefaults[] = Object.freeze([
  { tierId: 'T100', priceMin: 1, priceMax: 199, l0: 100_000n, floor: 20_000n },
  { tierId: 'T500', priceMin: 200, priceMax: 999, l0: 250_000n, floor: 50_000n },
  { tierId: 'T2K', priceMin: 1_000, priceMax: 4_999, l0: 1_000_000n, floor: 200_000n },
  { tierId: 'T10K', priceMin: 5_000, priceMax: 49_999, l0: 5_000_000n, floor: 1_000_000n },
  { tierId: 'T50K', priceMin: 50_000, priceMax: null, l0: 25_000_000n, floor: 5_000_000n },
])

export const DEFAULT_ECONOMICS_V1 = Object.freeze({
  rBp: 9_200,
  jBp: 0,
  mMax: 10,
  vMaxBp: 10_000,
  safetyMarginBp: 100,
  minGapBp: 50,
  /** Default lucky host cut (host_revenue_share_config.lucky_host_share_bp). */
  hostShareBp: 400,
})

/** Sum of the five outcome weights (must equal 10000 for a valid band). */
export function sumBandWeights(w: BandWeights): number {
  return LUCKY_OUTCOMES.reduce((acc, k) => acc + w[k], 0)
}

/**
 * Expected value of one band as a fraction of price, in bp: Σ weight_bp * mult_bp / 10000.
 * Exact integer for the shipped tables (e.g. normal = 9275). Not rounded; fractional only if
 * weights/multipliers are not multiples of the common factor.
 */
export function computeBandEvBp(weights: BandWeights): number {
  let num = 0
  for (const k of LUCKY_OUTCOMES) num += weights[k] * OUTCOME_MULTIPLIER_BP[k]
  return num / BP
}

export function computeAllBandEvBp(weights: BandWeightsByBand): Record<LuckyBand, number> {
  return {
    critical: computeBandEvBp(weights.critical),
    low: computeBandEvBp(weights.low),
    normal: computeBandEvBp(weights.normal),
    high: computeBandEvBp(weights.high),
  }
}

export class LuckyWeightsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LuckyWeightsError'
  }
}

/**
 * F2 (self-gift guard), strict:
 *   EV_high + ((h_bp + a_bp) / 10000) * v_max < 1 - safety_margin
 * i.e. a sender who gifts themselves (receiving host points h and agency a) can never profit.
 * Integer form (bp): EV_high*10000 + (h+a)*vMaxBp < 10000*10000 - safety*10000, all over 10000.
 */
export function selfGiftGuardMarginBp(args: {
  evHighBp: number
  hBp: number
  aBp?: number
  vMaxBp: number
  safetyMarginBp: number
}): number {
  const { evHighBp, hBp, aBp = 0, vMaxBp, safetyMarginBp } = args
  const lhs = evHighBp + ((hBp + aBp) * vMaxBp) / BP
  const rhs = BP - safetyMarginBp
  return rhs - lhs
}

/** Throws if F2 is violated (margin must be strictly positive). */
export function assertSelfGiftGuard(args: {
  evHighBp: number
  hBp: number
  aBp?: number
  vMaxBp: number
  safetyMarginBp: number
}): void {
  const margin = selfGiftGuardMarginBp(args)
  if (!(margin > 0)) {
    throw new LuckyWeightsError(
      `F2 self-gift guard violated: EV_high(${args.evHighBp}bp) + (h ${args.hBp} + a ${args.aBp ?? 0})bp * v_max(${args.vMaxBp}bp) ` +
        `must be < ${BP - args.safetyMarginBp}bp (margin ${margin}bp)`,
    )
  }
}

/** Structural check: every outcome is a non-negative integer and the band sums to 10000. */
export function assertBandWeightsShape(band: LuckyBand, w: BandWeights): void {
  for (const k of LUCKY_OUTCOMES) {
    const v = w[k]
    if (!Number.isInteger(v) || v < 0) {
      throw new LuckyWeightsError(`band ${band}: weight ${k} must be a non-negative integer (got ${v})`)
    }
  }
  const sum = sumBandWeights(w)
  if (sum !== BP) throw new LuckyWeightsError(`band ${band}: weights sum to ${sum}, expected ${BP}`)
}

/**
 * Full validation of a weight set against a tier's economics:
 *  - each band well-formed, sums to 10000
 *  - critical has no jackpot/medium mass beyond the ladder (critical: medium=jackpot=0; low: jackpot=0)
 *  - EV_critical < EV_low < r < EV_normal < EV_high, with EV_normal - r >= minGapBp
 *  - F2 on EV_high
 */
export function validateBandWeights(
  weights: BandWeightsByBand,
  econ: {
    rBp: number
    hBp: number
    aBp?: number
    vMaxBp: number
    safetyMarginBp: number
    minGapBp: number
  },
): Record<LuckyBand, number> {
  for (const band of LUCKY_BANDS) assertBandWeightsShape(band, weights[band])

  if (weights.critical.medium !== 0 || weights.critical.jackpot !== 0) {
    throw new LuckyWeightsError('critical band must not allow medium or jackpot outcomes')
  }
  if (weights.low.jackpot !== 0) throw new LuckyWeightsError('low band must not allow jackpot outcomes')

  const ev = computeAllBandEvBp(weights)
  if (!(ev.critical < ev.low)) throw new LuckyWeightsError(`EV_critical(${ev.critical}) must be < EV_low(${ev.low})`)
  if (!(ev.low < econ.rBp)) throw new LuckyWeightsError(`EV_low(${ev.low}) must be < r(${econ.rBp})`)
  if (!(econ.rBp < ev.normal)) throw new LuckyWeightsError(`r(${econ.rBp}) must be < EV_normal(${ev.normal})`)
  if (ev.normal - econ.rBp < econ.minGapBp) {
    throw new LuckyWeightsError(
      `EV_normal(${ev.normal}) - r(${econ.rBp}) = ${ev.normal - econ.rBp}bp is below min gap ${econ.minGapBp}bp`,
    )
  }
  if (!(ev.normal < ev.high)) throw new LuckyWeightsError(`EV_normal(${ev.normal}) must be < EV_high(${ev.high})`)

  assertSelfGiftGuard({
    evHighBp: ev.high,
    hBp: econ.hBp,
    aBp: econ.aBp,
    vMaxBp: econ.vMaxBp,
    safetyMarginBp: econ.safetyMarginBp,
  })
  return ev
}
