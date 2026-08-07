/**
 * Video call price helpers — prefer `videoCallPriceCapService` at runtime.
 * Sync helpers use TS defaults only (admin DB config is authoritative).
 * @see docs/flow-md/rates-levels-and-earnings-reference.md
 */

import {
  DEFAULT_VIDEO_CALL_PRICE_CAPS,
  MIN_CALL_PRICE_COINS_PER_MIN,
} from '../config/video-call-price-caps.defaults'

export { MIN_CALL_PRICE_COINS_PER_MIN }

/** @deprecated Sync fallback only — use videoCallPriceCapService.getMaxPriceForLevel. */
export function getMaxCallPriceForLevel(livestreamLevel: number): number {
  const allowed = DEFAULT_VIDEO_CALL_PRICE_CAPS.filter((t) => {
    if (livestreamLevel < t.minLevel) return false
    if (t.maxLevel != null && livestreamLevel > t.maxLevel) return false
    return true
  }).map((t) => t.price)
  if (allowed.length === 0) return MIN_CALL_PRICE_COINS_PER_MIN
  return Math.max(...allowed)
}
