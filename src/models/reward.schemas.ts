import { z } from 'zod'

export const ClaimLivestreamRewardSchema = z.object({
  part: z.union([z.literal(1), z.literal(2)]),
})

export type ClaimLivestreamRewardInput = z.infer<typeof ClaimLivestreamRewardSchema>

export const ClaimRoyalHostRewardSchema = z.object({
  rewardType: z
    .string()
    .regex(
      /^TIMING_STEP_[12]$|^GIFTING_TIER_\d+$/,
      'rewardType must be TIMING_STEP_1, TIMING_STEP_2, or GIFTING_TIER_<n>',
    ),
})

export type ClaimRoyalHostRewardInput = z.infer<typeof ClaimRoyalHostRewardSchema>

export const ClaimNormalHostRewardSchema = z.object({
  hourSlot: z.number().int().min(1).max(24),
})

export type ClaimNormalHostRewardInput = z.infer<typeof ClaimNormalHostRewardSchema>
