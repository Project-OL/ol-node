import { z } from 'zod'

export const ReplaceRatesSchema = z.object({
  tiers: z.array(
    z.object({
      minUsd: z.number().nonnegative(),
      maxUsd: z.number().nullable().optional(),
      coinsPerUsd: z.number().int().positive(),
    }),
  ),
})

export const ReplaceTradingTopupPackagesSchema = z.object({
  packages: z.array(
    z.object({
      tradingCoins: z.string().regex(/^\d+$/),
      priceCents: z.number().int().positive(),
      coinsPerUsd: z.number().int().positive(),
      currency: z.string().min(1).max(10).optional(),
      label: z.string().max(100).nullable().optional(),
    }),
  ),
})

export const ReplaceCoinPackagesSchema = z.object({
  packages: z.array(
    z.object({
      coins: z.number().int().positive(),
      priceCents: z.number().int().positive(),
      currency: z.string().min(1).max(10).optional(),
      label: z.string().max(100).nullable().optional(),
    }),
  ),
})

export const HostRevenueSharesUpdateSchema = z
  .object({
    giftReceiveBp: z.number().int().min(1).max(10_000).optional(),
    subscriptionBp: z.number().int().min(1).max(10_000).optional(),
    guardianPurchaseBp: z.number().int().min(1).max(10_000).optional(),
    videoCallHostShareBp: z.number().int().min(1).max(10_000).optional(),
  })
  .refine(
    (b) =>
      b.giftReceiveBp != null ||
      b.subscriptionBp != null ||
      b.guardianPurchaseBp != null ||
      b.videoCallHostShareBp != null,
    { message: 'Provide at least one share field' },
  )

export const WalletLevelConfigsReplaceSchema = z
  .object({
    wealth: z
      .array(
        z.object({
          level: z.number().int().positive(),
          threshold: z.string().regex(/^\d+$/),
          label: z.string().max(255).nullable().optional(),
          iconKey: z.string().max(255).nullable().optional(),
        }),
      )
      .optional(),
    livestream: z
      .array(
        z.object({
          level: z.number().int().positive(),
          threshold: z.string().regex(/^\d+$/),
          label: z.string().max(255).nullable().optional(),
          iconKey: z.string().max(255).nullable().optional(),
        }),
      )
      .optional(),
  })
  .refine((b) => b.wealth != null || b.livestream != null, {
    message: 'Provide wealth and/or livestream',
  })

export const CommissionLevelsReplaceSchema = z.object({
  levels: z
    .array(
      z.object({
        level: z.string().min(1).max(8),
        minWindowPoints: z.string().regex(/^\d+$/),
        liveRateBp: z.number().int().min(0).max(10_000),
        matchChatRateBp: z.number().int().min(0).max(10_000),
        sortOrder: z.number().int().min(0),
      }),
    )
    .min(1),
})

/** Soft-replace video-call allowed pricePerMin rows by livestream level band. */
export const ReplaceVideoCallPriceCapsSchema = z.object({
  tiers: z
    .array(
      z.object({
        minLevel: z.number().int().min(1),
        maxLevel: z.number().int().min(1).nullable().optional(),
        price: z.number().int().positive(),
        label: z.string().max(64).nullable().optional(),
      }),
    )
    .min(1),
})

/** Replace Elite / Rich tier recharge thresholds (exactly tiers 1–10). */
export const ReplaceRichTierConfigSchema = z.object({
  tiers: z
    .array(
      z.object({
        tier: z.number().int().min(1).max(10),
        minRechargeCoins: z.string().regex(/^\d+$/),
        displayName: z.string().trim().min(1).max(32),
      }),
    )
    .length(10),
})
