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
  { tradingCoins: 920_000n, priceCents: 10_000, coinsPerUsd: 9200, sortOrder: 1 },
  { tradingCoins: 4_750_000n, priceCents: 50_000, coinsPerUsd: 9500, sortOrder: 2 },
  { tradingCoins: 9_500_000n, priceCents: 100_000, coinsPerUsd: 9500, sortOrder: 3 },
  { tradingCoins: 19_800_000n, priceCents: 200_000, coinsPerUsd: 9900, sortOrder: 4 },
  { tradingCoins: 29_700_000n, priceCents: 300_000, coinsPerUsd: 9900, sortOrder: 5 },
  { tradingCoins: 44_550_000n, priceCents: 450_000, coinsPerUsd: 9900, sortOrder: 6 },
]
