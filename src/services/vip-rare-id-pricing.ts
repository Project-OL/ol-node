import { env } from '../config/env'
import { VipTier } from './vip-classifier.service'

const DEFAULT_BY_RANK: Record<number, number> = {
  1: 9_999,
  2: 49_999,
  3: 149_999,
  4: 499_999,
}

function tierRank(tier: VipTier): number | null {
  switch (tier) {
    case VipTier.BRONZE:
      return 1
    case VipTier.SILVER:
      return 2
    case VipTier.GOLD:
      return 3
    case VipTier.DIAMOND:
      return 4
    default:
      return null
  }
}

/** Credits price for a classified rare (VIP-pattern) public ID tier. Env: VIP_PRICE_TIER_1 … _4. */
export function priceCreditsForTier(tier: VipTier): number {
  const rank = tierRank(tier)
  if (rank == null) return 0
  const envOverrides = [
    env.VIP_PRICE_TIER_1,
    env.VIP_PRICE_TIER_2,
    env.VIP_PRICE_TIER_3,
    env.VIP_PRICE_TIER_4,
  ]
  const override = envOverrides[rank - 1]
  if (override != null && Number.isFinite(override)) return override
  return DEFAULT_BY_RANK[rank] ?? 0
}
