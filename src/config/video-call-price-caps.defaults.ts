/**
 * Fallback video-call allowed prices by host livestream level.
 * Production authority is `video_call_price_caps` (admin soft-replace).
 */
export type VideoCallPriceCapDefault = {
  minLevel: number
  maxLevel: number | null
  price: number
  label: string
}

export const DEFAULT_VIDEO_CALL_PRICE_CAPS: VideoCallPriceCapDefault[] = [
  { minLevel: 1, maxLevel: 4, price: 1800, label: '≤Lv4' },
  { minLevel: 5, maxLevel: 9, price: 2400, label: 'Lv5-9' },
  { minLevel: 10, maxLevel: null, price: 3000, label: 'Lv10 & Above' },
  { minLevel: 10, maxLevel: null, price: 3600, label: 'Lv10 & Above' },
  { minLevel: 10, maxLevel: null, price: 4800, label: 'Lv10 & Above' },
  { minLevel: 10, maxLevel: null, price: 6000, label: 'Lv10 & Above' },
  { minLevel: 10, maxLevel: null, price: 7200, label: 'Lv10 & Above' },
]

/** Lowest configured default price (also default VideoCallSettings.pricePerMin). */
export const MIN_CALL_PRICE_COINS_PER_MIN = 1800
