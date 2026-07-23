import { z } from 'zod'

export const ClaimLivestreamRewardSchema = z.object({
  part: z.union([z.literal(1), z.literal(2)]),
})

export type ClaimLivestreamRewardInput = z.infer<typeof ClaimLivestreamRewardSchema>
