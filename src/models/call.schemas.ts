import { z } from 'zod'
import { getMaxCallPriceForLevel, MIN_CALL_PRICE_COINS_PER_MIN } from '../utils/call-price'

export const MIN_CALL_PRICE = MIN_CALL_PRICE_COINS_PER_MIN

/** Creator's livestream level → max coins/min they may charge. */
export const CALL_PRICE_CAPS: { maxLevel: number; maxPrice: number }[] = [
  { maxLevel: 4, maxPrice: 1800 },
  { maxLevel: 9, maxPrice: 2400 },
  { maxLevel: 14, maxPrice: 3000 },
  { maxLevel: 19, maxPrice: 3600 },
  { maxLevel: 24, maxPrice: 4800 },
  { maxLevel: 29, maxPrice: 6000 },
  { maxLevel: 34, maxPrice: 7200 },
  { maxLevel: Infinity, maxPrice: 9600 }, // Lv35+
]

/** Return the max price allowed for a given livestream level. */
export function maxPriceForLevel(livestreamLevel: number): number {
  return getMaxCallPriceForLevel(livestreamLevel)
}

export const UpdateCallSettingsSchema = z
  .object({
    pricePerMin: z.number().int().min(MIN_CALL_PRICE).optional(),
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
