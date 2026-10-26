/**
 * F8 category mapping for the water_v1 lucky engine (Phase 3). Pure, BigInt-only.
 *
 * The `category` string is an opaque label the app stores and sockets forward (never a numeric
 * branch — see docs/lucky/WATER_LEVEL_DESIGN.md §1.9a). It must stay stable for analytics.
 *
 * Singles  — by the *paid* multiplier (after any downgrade):
 *   0 -> MISS, 0.5 -> SMALL, 1 -> EQUAL, 2.5 -> MEDIUM, 10 -> JACKPOT ; forced miss -> MISS.
 * Combos   — by bp = floor(ΣR * 10000 / S) (platform-favour floor):
 *   0 -> MISS ; [1,7500) -> UNLUCKY ; [7500,9500) -> NORMAL ; [9500,12500) -> BREAK_EVEN ; >=12500 -> WINNER.
 */
export type LuckySingleCategory = 'MISS' | 'SMALL' | 'EQUAL' | 'MEDIUM' | 'JACKPOT'
export type LuckyComboCategory = 'MISS' | 'UNLUCKY' | 'NORMAL' | 'BREAK_EVEN' | 'WINNER'
export type LuckyCategory = LuckySingleCategory | LuckyComboCategory

/**
 * Single lucky draw: label by the paid multiple of the unit price. A single pays exactly one of the
 * five outcomes (0, 0.5, 1, 2.5, 10), so bp buckets split at the midpoints separate them while
 * staying robust to integer floor on odd prices (e.g. floor(199/2)=99 -> 0.497x -> SMALL). Forced
 * miss (paid 0) is MISS.
 */
export function singleCategory(unitPrice: bigint, paidReward: bigint): LuckySingleCategory {
  if (paidReward <= 0n) return 'MISS'
  const bp = unitPrice > 0n ? (paidReward * 10_000n) / unitPrice : 0n
  if (bp < 7_500n) return 'SMALL' // ~0.5x
  if (bp < 17_500n) return 'EQUAL' // ~1x
  if (bp < 62_500n) return 'MEDIUM' // ~2.5x
  return 'JACKPOT' // ~10x
}

/** Combo lucky draw: label by the total paid vs total spend, floor bp, lower label on boundary. */
export function comboCategory(totalPaid: bigint, spend: bigint): LuckyComboCategory {
  const bp = spend > 0n ? (totalPaid * 10_000n) / spend : 0n
  if (bp === 0n) return 'MISS'
  if (bp < 7_500n) return 'UNLUCKY'
  if (bp < 9_500n) return 'NORMAL'
  if (bp < 12_500n) return 'BREAK_EVEN'
  return 'WINNER'
}

/**
 * Category for a complete water_v1 send: a single uses the one unit's paid multiplier; a combo uses
 * the total paid vs total spend.
 */
export function resolveCategory(args: {
  count: number
  unitPrice: bigint
  totalPaid: bigint
}): LuckyCategory {
  if (args.count <= 1) return singleCategory(args.unitPrice, args.totalPaid)
  return comboCategory(args.totalPaid, args.unitPrice * BigInt(args.count))
}
