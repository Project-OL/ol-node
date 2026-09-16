import { z } from 'zod'

export const RewardClaimTypeEnum = z.enum(['NORMAL_HOST', 'ROYAL_HOST', 'LIVESTREAM_STREAK'])

export const ListRewardClaimsQuerySchema = z.object({
  country: z.string().max(100).optional(),
  type: RewardClaimTypeEnum.optional(),
  agencyUserId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListRewardClaimsQuery = z.infer<typeof ListRewardClaimsQuerySchema>

export const ExportRewardClaimsQuerySchema = z.object({
  country: z.string().max(100).optional(),
  type: RewardClaimTypeEnum.optional(),
  agencyUserId: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
})
export type ExportRewardClaimsQuery = z.infer<typeof ExportRewardClaimsQuerySchema>
