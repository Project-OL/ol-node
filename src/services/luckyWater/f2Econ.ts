import { agencyCommissionRepository } from '../../repositories/agencyCommission.repository'
import type { HostRevenueShares } from '../../config/host-revenue-shares'

/** Agency commission as bp of coin spend: host_bp × agency_rate_on_host / 10000. */
export function agencyShareBpOfSpend(hostShareBp: number, agencyRateOnHostBp: number): number {
  return Math.floor((hostShareBp * agencyRateOnHostBp) / 10_000)
}

/** Worst-case agency rate on host points (live vs match/chat) across configured levels. */
export async function maxAgencyRateOnHostBp(): Promise<number> {
  const levels = await agencyCommissionRepository.getLevelConfig()
  if (levels.length === 0) return 0
  return Math.max(...levels.map((l) => Math.max(l.liveRateBp, l.matchChatRateBp)))
}

export async function buildLuckyF2Econ(
  shares: Pick<HostRevenueShares, 'luckyHostShareBp' | 'luckyWaterAgencyCommission'>,
  tier: {
    rBp: number
    vMaxBp: number
    safetyMarginBp: number
    minGapBp: number
  },
): Promise<{
  rBp: number
  hBp: number
  aBp: number
  vMaxBp: number
  safetyMarginBp: number
  minGapBp: number
}> {
  let aBp = 0
  if (shares.luckyWaterAgencyCommission) {
    const maxRate = await maxAgencyRateOnHostBp()
    aBp = agencyShareBpOfSpend(shares.luckyHostShareBp, maxRate)
  }
  return {
    rBp: tier.rBp,
    hBp: shares.luckyHostShareBp,
    aBp,
    vMaxBp: tier.vMaxBp,
    safetyMarginBp: tier.safetyMarginBp,
    minGapBp: tier.minGapBp,
  }
}
