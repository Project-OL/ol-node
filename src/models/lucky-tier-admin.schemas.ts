import { z } from 'zod'
import { LUCKY_BANDS, LUCKY_OUTCOMES, LUCKY_TIER_IDS } from '../services/luckyWater/bandWeights'

const luckyTierIdSchema = z.enum(LUCKY_TIER_IDS)

const bandWeightsSchema = z.object(
  Object.fromEntries(LUCKY_OUTCOMES.map((k) => [k, z.number().int().min(0)])) as Record<
    (typeof LUCKY_OUTCOMES)[number],
    z.ZodNumber
  >,
)

const bandWeightsByBandSchema = z.object(
  Object.fromEntries(LUCKY_BANDS.map((b) => [b, bandWeightsSchema])) as Record<
    (typeof LUCKY_BANDS)[number],
    typeof bandWeightsSchema
  >,
)

export const LuckyTierModeSchema = z.enum(['off', 'shadow', 'enforce'])

export const LuckyTierSeedChoiceSchema = z.enum(['seed', 'start_empty', 'capped_ladder'])

export const LuckyTierConfigVersionCreateSchema = z
  .object({
    rBp: z.number().int().min(1).max(10_000).optional(),
    jBp: z.number().int().min(0).max(10_000).optional(),
    l0: z.string().regex(/^\d+$/).optional(),
    floor: z.string().regex(/^\d+$/).optional(),
    lambdaCriticalMaxBp: z.number().int().min(1).optional(),
    lambdaLowMaxBp: z.number().int().min(1).optional(),
    lambdaNormalMaxBp: z.number().int().min(1).optional(),
    bandWeights: bandWeightsByBandSchema.optional(),
    weightTableId: z.string().min(1).max(64).optional(),
    mMax: z.number().int().min(1).optional(),
    vMaxBp: z.number().int().min(1).optional(),
    safetyMarginBp: z.number().int().min(0).optional(),
    minGapBp: z.number().int().min(0).optional(),
    dailyWinCapCoins: z.string().regex(/^\d+$/).optional(),
    coolDownAfterBigWinSeconds: z.number().int().min(0).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one config field' })

export const LuckyTierModeUpdateSchema = z.object({
  mode: LuckyTierModeSchema,
  /** Required when enabling enforce without prior shadow history (F10 ops gate). */
  enforceOverrideReason: z.string().trim().min(3).max(500).optional(),
})

export const LuckyTierSeedBodySchema = z.object({
  choice: LuckyTierSeedChoiceSchema,
  /** Required when choice=seed; ignored for start_empty / capped_ladder. */
  amount: z.string().regex(/^\d+$/).optional(),
  reason: z.string().trim().max(500).optional(),
})

export const LuckyTierIdParamSchema = z.object({
  tierId: luckyTierIdSchema,
})
