import { LevelType, PrismaClient } from "@prisma/client";
import {
  DEFAULT_AGENT_EXCHANGE_RATES,
  DEFAULT_COIN_TRADING_TOPUP_RATES,
} from "../src/config/coin-trading-rates.defaults";
import { DEFAULT_COIN_TRADING_TOPUP_PACKAGES } from "../src/config/coin-trading-topup-packages.defaults";
import {
  DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS,
  DEFAULT_WEALTH_LEVEL_THRESHOLDS,
} from "../src/config/wallet-level-thresholds.defaults";

const prisma = new PrismaClient();

async function seedWalletLevelConfigs(
  levelType: LevelType,
  thresholds: { level: number; threshold: bigint }[],
  deactivateAboveLevel?: number,
) {
  for (const t of thresholds) {
    await prisma.walletLevelConfig.upsert({
      where: { levelType_level: { levelType, level: t.level } },
      create: {
        levelType,
        level: t.level,
        threshold: t.threshold,
        isActive: true,
      },
      update: { threshold: t.threshold, isActive: true },
    });
  }
  if (deactivateAboveLevel != null) {
    await prisma.walletLevelConfig.updateMany({
      where: { levelType, level: { gt: deactivateAboveLevel } },
      data: { isActive: false },
    });
  }
}

async function main() {
  await prisma.coinPackage.createMany({
    data: [
      { coins: 18_500, priceCents: 299, label: null, sortOrder: 1 },
      { coins: 64_000, priceCents: 999, label: null, sortOrder: 2 },
      { coins: 193_000, priceCents: 2999, label: "Popular", sortOrder: 3 },
      { coins: 655_000, priceCents: 9999, label: null, sortOrder: 4 },
    ],
    skipDuplicates: true,
  });

  await seedWalletLevelConfigs(
    LevelType.WEALTH,
    DEFAULT_WEALTH_LEVEL_THRESHOLDS,
    200,
  );
  await seedWalletLevelConfigs(
    LevelType.LIVESTREAM,
    DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS,
    35,
  );

  await prisma.richTierConfig.createMany({
    data: [
      { tier: 1, minRechargeCoins: 3_000_000n, displayName: "RICH I" },
      { tier: 2, minRechargeCoins: 5_000_000n, displayName: "RICH II" },
      { tier: 3, minRechargeCoins: 10_000_000n, displayName: "RICH III" },
      { tier: 4, minRechargeCoins: 20_000_000n, displayName: "RICH IV" },
      { tier: 5, minRechargeCoins: 30_000_000n, displayName: "RICH V" },
      { tier: 6, minRechargeCoins: 50_000_000n, displayName: "RICH VI" },
      { tier: 7, minRechargeCoins: 100_000_000n, displayName: "RICH VII" },
      { tier: 8, minRechargeCoins: 200_000_000n, displayName: "RICH VIII" },
      { tier: 9, minRechargeCoins: 500_000_000n, displayName: "RICH IX" },
      { tier: 10, minRechargeCoins: 1_000_000_000n, displayName: "RICH X" },
    ],
    skipDuplicates: true,
  });

  await prisma.coinTradingTopupRate.createMany({
    data: DEFAULT_COIN_TRADING_TOPUP_RATES.map((tier, i) => ({
      minUsd: String(tier.minUsd),
      maxUsd: tier.maxUsd == null ? null : String(tier.maxUsd),
      coinsPerUsd: tier.coinsPerUsd,
      sortOrder: i + 1,
    })),
    skipDuplicates: true,
  });

  await prisma.agentExchangeRate.createMany({
    data: DEFAULT_AGENT_EXCHANGE_RATES.map((tier, i) => ({
      minUsdEquiv: String(tier.minUsd),
      maxUsdEquiv: tier.maxUsd == null ? null : String(tier.maxUsd),
      coinsPerUsd: tier.coinsPerUsd,
      sortOrder: i + 1,
    })),
    skipDuplicates: true,
  });

  await prisma.coinTradingTopupPackage.createMany({
    data: DEFAULT_COIN_TRADING_TOPUP_PACKAGES.map((pkg) => ({
      tradingCoins: pkg.tradingCoins,
      priceCents: pkg.priceCents,
      coinsPerUsd: pkg.coinsPerUsd,
      sortOrder: pkg.sortOrder,
      label: pkg.label ?? null,
    })),
    skipDuplicates: true,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
