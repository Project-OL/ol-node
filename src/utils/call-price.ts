/**
 * Video call price cap rules by host livestream level.
 * @see docs/flow-md/rates-levels-and-earnings-reference.md § 11
 */

export const MIN_CALL_PRICE_COINS_PER_MIN = 1800

export function getMaxCallPriceForLevel(livestreamLevel: number): number {
  if (livestreamLevel <= 4) return 1800
  if (livestreamLevel <= 9) return 2400
  if (livestreamLevel <= 14) return 3000
  if (livestreamLevel <= 19) return 3600
  if (livestreamLevel <= 24) return 4800
  if (livestreamLevel <= 29) return 6000
  if (livestreamLevel <= 34) return 7200
  return 9600 // Level 35+
}
