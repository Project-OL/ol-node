/**
 * Default agency TRADING_COIN rate tiers (product spec).
 * - Top-up (Epay): USD purchase amount N
 * - Exchange: points → trading coins; tiers keyed on USD equivalent (points / 10_000)
 */

export type RateTierUsd = {
  minUsd: number;
  maxUsd: number | null;
  coinsPerUsd: number;
};

/** Purchase coins through Epay — $N per single purchase */
export const DEFAULT_COIN_TRADING_TOPUP_RATES: RateTierUsd[] = [
  { minUsd: 0, maxUsd: 500, coinsPerUsd: 9200 },
  { minUsd: 500, maxUsd: 2000, coinsPerUsd: 9500 },
  { minUsd: 2000, maxUsd: null, coinsPerUsd: 9900 },
];

/** Exchange points for coins — USD equivalent of points exchanged */
export const DEFAULT_AGENT_EXCHANGE_RATES: RateTierUsd[] = [
  { minUsd: 0, maxUsd: 50, coinsPerUsd: 9200 },
  { minUsd: 50, maxUsd: 1000, coinsPerUsd: 9500 },
  { minUsd: 1000, maxUsd: null, coinsPerUsd: 9900 },
];
