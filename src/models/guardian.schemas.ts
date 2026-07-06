import { z } from 'zod'

export const GuardianTierEnum = z.enum(['SILVER', 'GOLD', 'KING'])

export const PurchaseGuardianSchema = z.object({
  targetUserId: z.string().min(1),
  tier: GuardianTierEnum,
  durationMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
  /** Optional client retry token; same key replays the original result instead of re-purchasing. */
  idempotencyKey: z.string().min(8).max(128).optional(),
})

export type PurchaseGuardianInput = z.infer<typeof PurchaseGuardianSchema>
