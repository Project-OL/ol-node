import { z } from 'zod'

export const GuardianTierEnum = z.enum(['SILVER', 'GOLD', 'KING'])

export const PurchaseGuardianSchema = z.object({
  targetUserId: z.string().min(1),
  tier: GuardianTierEnum,
  durationMonths: z.union([z.literal(1), z.literal(3), z.literal(6), z.literal(12)]),
})

export type PurchaseGuardianInput = z.infer<typeof PurchaseGuardianSchema>
