import { prismaRead } from '../../config/database'
import type { HostRevenueShares } from '../../config/host-revenue-shares'
import { AppError } from '../../middlewares/errorHandler'
import { LUCKY_TIER_IDS, LuckyWeightsError, validateBandWeights, type BandWeightsByBand } from './bandWeights'
import { buildLuckyF2Econ } from './f2Econ'

/**
 * Re-run F2 on every tier whose latest config is in shadow or enforce.
 * Used before saving host lucky cut / water agency commission flags.
 */
export async function assertShadowEnforceTiersPassF2(
  shares: HostRevenueShares,
): Promise<void> {
  const violations: string[] = []

  for (const tierId of LUCKY_TIER_IDS) {
    const row = await prismaRead.luckyTierConfig.findFirst({
      where: { tierId },
      orderBy: { version: 'desc' },
    })
    if (!row || (row.mode !== 'shadow' && row.mode !== 'enforce')) continue

    try {
      const weights = row.bandWeightsJson as unknown as BandWeightsByBand
      const econ = await buildLuckyF2Econ(shares, row)
      validateBandWeights(weights, econ)
    } catch (e) {
      if (e instanceof LuckyWeightsError) {
        violations.push(`${tierId} v${row.version} (${row.mode}): ${e.message}`)
      } else {
        throw e
      }
    }
  }

  if (violations.length > 0) {
    throw new AppError(
      422,
      'Host lucky settings would violate the self-gift guard (F2) on active water-level tiers',
      'LUCKY_TIER_F2_VIOLATION',
      { violations },
    )
  }
}
