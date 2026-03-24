import { z } from 'zod'

export const getSettingsSchema = z.object({})

export const togglePrivacySchema = z.object({
  enabled: z.boolean(),
})

export const privacyFeatures = [
  'invisibleVisitor',
  'mysteryLive',
  'mysteryRank',
  'invisibleOnline',
] as const

export const privacyFeatureSchema = z.enum(privacyFeatures)

export type GetSettingsQuery = z.infer<typeof getSettingsSchema>
export type TogglePrivacyBody = z.infer<typeof togglePrivacySchema>
export type PrivacyFeature = z.infer<typeof privacyFeatureSchema>
