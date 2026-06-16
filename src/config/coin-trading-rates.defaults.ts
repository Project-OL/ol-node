/**
 * Default agency TRADING_COIN rate tiers (product spec).
 * - Top-up (Epay): USD purchase amount N
 * - Exchange: points → trading coins; tiers keyed on USD equivalent (points / 10_000)
 */

export type RateTierUsd = {
  minUsd: number
  maxUsd: number | null
  coinsPerUsd: number
}

/** Purchase coins through Epay — $N per single purchase */
export const DEFAULT_COIN_TRADING_TOPUP_RATES: RateTierUsd[] = [
  { minUsd: 0, maxUsd: 500, coinsPerUsd: 9400 },
  { minUsd: 500, maxUsd: 1000, coinsPerUsd: 9700 },
  { minUsd: 1000, maxUsd: 2000, coinsPerUsd: 9900 },
  { minUsd: 2000, maxUsd: null, coinsPerUsd: 10000 },
]

/** Exchange points for coins — USD equivalent of points exchanged (agents) */
export const DEFAULT_AGENT_EXCHANGE_RATES: RateTierUsd[] = [
  { minUsd: 0, maxUsd: 50, coinsPerUsd: 9200 },
  { minUsd: 50, maxUsd: 1000, coinsPerUsd: 9500 },
  { minUsd: 1000, maxUsd: null, coinsPerUsd: 9900 },
]

/** Exchange points for personal coins — USD equivalent of points exchanged (non-agents) */
export const PERSONAL_COIN_EXCHANGE_RATES: RateTierUsd[] = [
  { minUsd: 0, maxUsd: 50, coinsPerUsd: 9000 },
  { minUsd: 50, maxUsd: 1000, coinsPerUsd: 9400 },
  { minUsd: 1000, maxUsd: null, coinsPerUsd: 9700 },
]

/** Fixed point-to-coin exchange packages for UI display */
export const PERSONAL_EXCHANGE_PACKAGES = [
  {
    id: 'pkg_exchange_100k',
    pointsRequired: 100_000n,
    coinsAwarded: 92_000n,
    coinsPerUsd: 9200,
    label: '100K Points',
  },
  {
    id: 'pkg_exchange_500k',
    pointsRequired: 500_000n,
    coinsAwarded: 475_000n,
    coinsPerUsd: 9500,
    label: '500K Points',
  },
] as const
