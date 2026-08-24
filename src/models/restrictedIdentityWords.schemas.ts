import { z } from 'zod'

export const RestrictedWordSchema = z.string().trim().min(1).max(100)

export const ReplaceRestrictedIdentityWordsSchema = z.object({
  words: z.array(RestrictedWordSchema).max(500),
})

export type ReplaceRestrictedIdentityWordsInput = z.infer<
  typeof ReplaceRestrictedIdentityWordsSchema
>
