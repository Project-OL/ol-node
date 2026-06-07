import { z } from 'zod'

export const MIN_CALL_PRICE = 1800

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
  for (const tier of CALL_PRICE_CAPS) {
    if (livestreamLevel <= tier.maxLevel) return tier.maxPrice
  }
  return 9600
}

export const UpdateCallSettingsSchema = z
  .object({
    pricePerMin: z.number().int().min(MIN_CALL_PRICE).optional(),
    blockLv5: z.boolean().optional(),
    blockLv10: z.boolean().optional(),
  })
  .refine(
    (d) => d.pricePerMin !== undefined || d.blockLv5 !== undefined || d.blockLv10 !== undefined,
    { message: 'At least one field required' },
  )

export const InitiateCallSchema = z.object({
  creatorPublicId: z.string().min(1),
})

export type UpdateCallSettingsInput = z.infer<typeof UpdateCallSettingsSchema>
export type InitiateCallInput = z.infer<typeof InitiateCallSchema>
