import { prisma } from '../../config/database'
import type { HostRevenueShares } from '../../config/host-revenue-shares'
import { AppError } from '../../middlewares/errorHandler'
import { LUCKY_TIER_IDS, LuckyWeightsError, validateBandWeights, type BandWeightsByBand } from './bandWeights'
import { buildLuckyF2Econ } from './f2Econ'

/**
 * Re-run F2 on the latest config of every tier whose `lucky_tier_mode` is shadow or enforce.
 * Used before saving host lucky cut / water agency commission flags. Mode comes from the mode
 * table (B7): `lucky_tier_config.mode` is a stale snapshot that setMode no longer writes.
 */
export async function assertShadowEnforceTiersPassF2(
  shares: HostRevenueShares,
): Promise<void> {
  const violations: string[] = []
  const modeRows = await prisma.luckyTierMode.findMany({
    where: { mode: { in: ['shadow', 'enforce'] } },
  })
  const activeModes = new Map(modeRows.map((m) => [m.tierId, m.mode]))

  for (const tierId of LUCKY_TIER_IDS) {
    const mode = activeModes.get(tierId)
    if (!mode) continue
    const row = await prisma.luckyTierConfig.findFirst({
      where: { tierId },
      orderBy: { version: 'desc' },
    })
    if (!row) continue

    try {
      const weights = row.bandWeightsJson as unknown as BandWeightsByBand
      const econ = await buildLuckyF2Econ(shares, row)
      validateBandWeights(weights, econ)
    } catch (e) {
      if (e instanceof LuckyWeightsError) {
        violations.push(`${tierId} v${row.version} (${mode}): ${e.message}`)
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
