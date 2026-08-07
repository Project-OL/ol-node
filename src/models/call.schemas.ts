import { z } from 'zod'
import { getMaxCallPriceForLevel, MIN_CALL_PRICE_COINS_PER_MIN } from '../utils/call-price'

export const MIN_CALL_PRICE = MIN_CALL_PRICE_COINS_PER_MIN

/**
 * @deprecated Sync fallback from TS defaults only.
 * Runtime caps: `videoCallPriceCapService` / DB `video_call_price_caps`.
 */
export const CALL_PRICE_CAPS: { maxLevel: number; maxPrice: number }[] = [
  { maxLevel: 4, maxPrice: 1800 },
  { maxLevel: 9, maxPrice: 2400 },
  { maxLevel: Infinity, maxPrice: 7200 },
]

/** @deprecated Prefer videoCallPriceCapService.getMaxPriceForLevel (async, DB-backed). */
export function maxPriceForLevel(livestreamLevel: number): number {
  return getMaxCallPriceForLevel(livestreamLevel)
}

export const UpdateCallSettingsSchema = z
  .object({
    /** Must be an allowed price for the host's livestream level (see GET /call/price-table). */
    pricePerMin: z.number().int().positive().optional(),
    blockLv5: z.boolean().optional(),
    blockLv10: z.boolean().optional(),
    /** Global availability: false = do not receive video calls right now. */
    acceptVideoCalls: z.boolean().optional(),
  })
  .refine(
    (d) =>
      d.pricePerMin !== undefined ||
      d.blockLv5 !== undefined ||
      d.blockLv10 !== undefined ||
      d.acceptVideoCalls !== undefined,
    { message: 'At least one field required' },
  )

export const updateAcceptVideoCallsSchema = z.object({
  acceptVideoCalls: z.boolean(),
})

export const InitiateCallSchema = z.object({
  creatorPublicId: z.string().min(1),
})

export type UpdateCallSettingsInput = z.infer<typeof UpdateCallSettingsSchema>
export type UpdateAcceptVideoCallsInput = z.infer<typeof updateAcceptVideoCallsSchema>
export type InitiateCallInput = z.infer<typeof InitiateCallSchema>
