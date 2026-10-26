/**
 * water_v1 draw engine (Phase 3) — pure, BigInt-only, CSPRNG-injected. No DB, and no non-crypto RNG
 * (the caller injects crypto.randomInt; this file never reaches for the standard-library generator).
 *
 * Design: docs/lucky/WATER_LEVEL_DESIGN.md (§4, §6, §7). The caller (internalLedger.service)
 * supplies the current pool water `W` (after inflow), the tier config, the per-user cap state and a
 * `randomInt` (crypto.randomInt in production), and gets back one record per unit plus the totals.
 *
 * Per unit:
 *   1. band  = f(λ = W / L0)  via the config's lambda*MaxBp thresholds (recomputed each unit as W falls)
 *   2. roll  = randomInt(0, 10000) against the band's cumulative weights -> outcome
 *   3. R_raw = floor(P * m_num / m_den)   (half 1/2, equal 1/1, medium 5/2, jackpot 10/1, miss 0)
 *   4. caps, in order:
 *        a. m_max   : R <= P * m_max                                  (reduce, not a downgrade)
 *        b. user caps (F13): daily win cap / cool-down after a big win -> force miss (USER_CAP)
 *        c. pool floor      : R <= W - floor                          -> force miss (POOL_FLOOR)
 *   5. W -= R_paid
 */
import {
  LUCKY_OUTCOMES,
  type BandWeights,
  type BandWeightsByBand,
  type LuckyBand,
  type LuckyOutcome,
} from './bandWeights'

/** Reward multiplier of the unit price per outcome, as an exact fraction (no float). */
export const OUTCOME_FRACTION: Readonly<Record<LuckyOutcome, { num: bigint; den: bigint }>> =
  Object.freeze({
    miss: { num: 0n, den: 1n },
    half: { num: 1n, den: 2n },
    equal: { num: 1n, den: 1n },
    medium: { num: 5n, den: 2n },
    jackpot: { num: 10n, den: 1n },
  })

/** A big win (triggers cool-down, F13) is a paid reward of >= 10x the unit price. */
export const BIG_WIN_MULTIPLE = 10n

export type DrawDowngrade = 'POOL_FLOOR' | 'USER_CAP'

/** λ cutoffs in bp (10000 = 1.0): critical < criticalMax <= low < lowMax <= normal < normalMax <= high. */
export interface LambdaThresholds {
  criticalMaxBp: number
  lowMaxBp: number
  normalMaxBp: number
}

export interface UnitDraw {
  i: number
  band: LuckyBand
  roll: number
  rollMax: number
  outcome: LuckyOutcome
  mNum: number
  mDen: number
  /** String (not BigInt) so the record is JSON-serialisable for `drawn_json`. */
  rRaw: string
  rPaid: string
  downgrade: DrawDowngrade | null
}

export interface DrawUnitsParams {
  unitPrice: bigint
  count: number
  weights: BandWeightsByBand
  thresholds: LambdaThresholds
  l0: bigint
  floor: bigint
  mMax: number
  /** Pool water AFTER inflow has been added, i.e. the balance these units draw against. */
  startingWater: bigint
  /** Daily win cap in coins (0 = off). */
  dailyWinCapCoins: bigint
  /** This user's water reward already paid today on this tier (for the daily cap). */
  priorDailyWon: bigint
  /** A prior big win puts the user in cool-down at the start of this send (force miss). */
  coolDownActive: boolean
  randomInt: (min: number, max: number) => number
}

export interface DrawUnitsResult {
  units: UnitDraw[]
  /** Per-unit paid reward (length === count); feeds collapseBreakdown. */
  rewards: bigint[]
  totalPaid: bigint
  /** Pool water after all units (startingWater - totalPaid); always >= floor when totalPaid > 0. */
  finalWater: bigint
  /** True if any unit paid >= 10x the unit price (recorded for future cool-down detection). */
  bigWin: boolean
}

/** λ = W / L0 in bp (10000 = 1.0), as a BigInt floor; L0 > 0 by config CHECK. */
export function lambdaBp(w: bigint, l0: bigint): bigint {
  if (l0 <= 0n) return 0n
  return (w * 10_000n) / l0
}

/** Band for the current water level using the tier's three threshold cutoffs. */
export function bandForWater(w: bigint, l0: bigint, t: LambdaThresholds): LuckyBand {
  const lam = lambdaBp(w, l0)
  if (lam < BigInt(t.criticalMaxBp)) return 'critical'
  if (lam < BigInt(t.lowMaxBp)) return 'low'
  if (lam < BigInt(t.normalMaxBp)) return 'normal'
  return 'high'
}

/** Pick an outcome from a roll in [0, 10000) against cumulative band weights (sum must be 10000). */
export function outcomeFromRoll(weights: BandWeights, roll: number): LuckyOutcome {
  let acc = 0
  for (const outcome of LUCKY_OUTCOMES) {
    acc += weights[outcome]
    if (roll < acc) return outcome
  }
  return 'miss'
}

/** Unit inflow basis: reject a price so small that floor(P * r_bp / 10000) would be 0 (F9). */
export function unitInflowOk(price: bigint, rBp: number): boolean {
  return price * BigInt(rBp) >= 10_000n
}

/** Inflow added to the pool for a spend of `S` coins at rate `r_bp` (floor, platform-favour). */
export function computeInflow(spend: bigint, rBp: number): bigint {
  return (spend * BigInt(rBp)) / 10_000n
}

/** R_raw for an outcome at a given price (exact BigInt fraction, floor). */
export function rawReward(price: bigint, outcome: LuckyOutcome): bigint {
  const frac = OUTCOME_FRACTION[outcome]
  return frac.num === 0n ? 0n : (price * frac.num) / frac.den
}

/**
 * N independent unit draws against the same (already-inflowed) water `startingWater`. Pure: all
 * randomness comes from `randomInt`. Force-miss keeps `W >= floor` at every paid step (bounded-loss
 * guarantee), so `finalWater >= floor` whenever `totalPaid > 0`.
 */
export function drawUnits(params: DrawUnitsParams): DrawUnitsResult {
  const {
    unitPrice,
    count,
    weights,
    thresholds,
    l0,
    floor,
    mMax,
    startingWater,
    dailyWinCapCoins,
    priorDailyWon,
    coolDownActive,
    randomInt,
  } = params

  const mMaxCapAmount = unitPrice * BigInt(mMax)
  const bigWinAmount = unitPrice * BIG_WIN_MULTIPLE
  const capOn = dailyWinCapCoins > 0n
  let capRemaining = capOn ? dailyWinCapCoins - priorDailyWon : 0n

  let w = startingWater
  let totalPaid = 0n
  let bigWin = false
  const units: UnitDraw[] = []
  const rewards: bigint[] = []

  for (let i = 0; i < count; i++) {
    const band = bandForWater(w, l0, thresholds)
    const bandWeights = weights[band]
    const roll = randomInt(0, 10_000)
    const outcome = outcomeFromRoll(bandWeights, roll)
    const rRaw = rawReward(unitPrice, outcome)
    const frac = OUTCOME_FRACTION[outcome]

    // a) m_max cap (reduce, not a downgrade)
    const rCap = rRaw > mMaxCapAmount ? mMaxCapAmount : rRaw
    let rPaid = rCap
    let downgrade: DrawDowngrade | null = null

    if (rCap > 0n) {
      if (coolDownActive) {
        // b) cool-down after a recent big win -> force miss
        rPaid = 0n
        downgrade = 'USER_CAP'
      } else if (capOn && rCap > capRemaining) {
        // b) daily win cap -> force miss
        rPaid = 0n
        downgrade = 'USER_CAP'
      } else if (rCap > w - floor) {
        // c) pool floor -> force miss
        rPaid = 0n
        downgrade = 'POOL_FLOOR'
      }
    }

    w -= rPaid
    totalPaid += rPaid
    if (capOn) capRemaining -= rPaid
    if (rPaid >= bigWinAmount && rPaid > 0n) bigWin = true

    rewards.push(rPaid)
    units.push({
      i,
      band,
      roll,
      rollMax: 10_000,
      outcome,
      mNum: Number(frac.num),
      mDen: Number(frac.den),
      rRaw: rRaw.toString(),
      rPaid: rPaid.toString(),
      downgrade,
    })
  }

  return { units, rewards, totalPaid, finalWater: w, bigWin }
}

/**
 * Collapse N per-unit rewards into at most `maxGroups` contiguous breakdown entries, preserving the
 * total. N <= maxGroups returns one entry per unit; otherwise the first `N % maxGroups` groups take
 * one extra unit (combo step array for the app, which walks <= 10 steps).
 */
export function collapseBreakdown(perUnit: bigint[], maxGroups = 10): bigint[] {
  const n = perUnit.length
  if (n <= maxGroups) return perUnit.slice()
  const base = Math.floor(n / maxGroups)
  const extra = n % maxGroups
  const out: bigint[] = []
  let idx = 0
  for (let g = 0; g < maxGroups; g++) {
    const size = base + (g < extra ? 1 : 0)
    let sum = 0n
    for (let k = 0; k < size; k++) sum += perUnit[idx++]
    out.push(sum)
  }
  return out
}
