/**
 * Replace active agency trading top-up packages with product defaults.
 * Usage: npm run seed:coin-trading-topup-packages
 */
import { PrismaClient } from "@prisma/client";
import { redisClient, RedisKeys } from "../src/config/redis";
import { DEFAULT_COIN_TRADING_TOPUP_PACKAGES } from "../src/config/coin-trading-topup-packages.defaults";

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.coinTradingTopupPackage.updateMany({ data: { isActive: false } });
    for (const pkg of DEFAULT_COIN_TRADING_TOPUP_PACKAGES) {
      await tx.coinTradingTopupPackage.create({
        data: {
          tradingCoins: pkg.tradingCoins,
          priceCents: pkg.priceCents,
          coinsPerUsd: pkg.coinsPerUsd,
          sortOrder: pkg.sortOrder,
          label: pkg.label ?? null,
          isActive: true,
        },
      });
    }
  });
  await redisClient.del(RedisKeys.ctTopupPackages());
  const active = await prisma.coinTradingTopupPackage.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  console.log(`Seeded ${active.length} trading top-up package(s):`);
  for (const p of active) {
    console.log(
      `  $${(p.priceCents / 100).toFixed(0)} → ${p.tradingCoins.toString()} coins (id ${p.id})`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
