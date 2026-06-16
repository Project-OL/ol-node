/**
 * Fixed agency TRADING_COIN Epay top-up packages (product UI).
 * Coins match tiered rates at each USD price point.
 */

export type TradingTopupPackageDef = {
  tradingCoins: bigint
  priceCents: number
  coinsPerUsd: number
  sortOrder: number
  label?: string
}

export const DEFAULT_COIN_TRADING_TOPUP_PACKAGES: TradingTopupPackageDef[] = [
  { tradingCoins: 940_000n, priceCents: 10_000, coinsPerUsd: 9400, sortOrder: 1 },
  { tradingCoins: 4_850_000n, priceCents: 50_000, coinsPerUsd: 9700, sortOrder: 2 },
  { tradingCoins: 9_900_000n, priceCents: 100_000, coinsPerUsd: 9900, sortOrder: 3 },
  { tradingCoins: 20_000_000n, priceCents: 200_000, coinsPerUsd: 10000, sortOrder: 4 },
  { tradingCoins: 30_000_000n, priceCents: 300_000, coinsPerUsd: 10000, sortOrder: 5 },
  { tradingCoins: 50_000_000n, priceCents: 500_000, coinsPerUsd: 10000, sortOrder: 6 },
]
