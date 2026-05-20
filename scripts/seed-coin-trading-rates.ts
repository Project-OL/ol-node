/**
 * Apply default coin-trading top-up and exchange rate tiers (replaces all active rows).
 *
 * Usage: npx tsx scripts/seed-coin-trading-rates.ts
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { redisClient, RedisKeys } from "../src/config/redis";
import {
  DEFAULT_AGENT_EXCHANGE_RATES,
  DEFAULT_COIN_TRADING_TOPUP_RATES,
} from "../src/config/coin-trading-rates.defaults";

async function replaceTopupRates() {
  await prisma.$transaction(async (tx) => {
    await tx.coinTradingTopupRate.updateMany({ data: { isActive: false } });
    for (let i = 0; i < DEFAULT_COIN_TRADING_TOPUP_RATES.length; i++) {
      const tier = DEFAULT_COIN_TRADING_TOPUP_RATES[i]!;
      await tx.coinTradingTopupRate.create({
        data: {
          minUsd: tier.minUsd,
          maxUsd: tier.maxUsd,
          coinsPerUsd: tier.coinsPerUsd,
          sortOrder: i + 1,
          isActive: true,
        },
      });
    }
  });
}

async function replaceExchangeRates() {
  await prisma.$transaction(async (tx) => {
    await tx.agentExchangeRate.updateMany({ data: { isActive: false } });
    for (let i = 0; i < DEFAULT_AGENT_EXCHANGE_RATES.length; i++) {
      const tier = DEFAULT_AGENT_EXCHANGE_RATES[i]!;
      await tx.agentExchangeRate.create({
        data: {
          minUsdEquiv: tier.minUsd,
          maxUsdEquiv: tier.maxUsd,
          coinsPerUsd: tier.coinsPerUsd,
          sortOrder: i + 1,
          isActive: true,
        },
      });
    }
  });
}

async function main() {
  await replaceTopupRates();
  await replaceExchangeRates();
  await redisClient.del(RedisKeys.ctTopupRates(), RedisKeys.ctExchangeRates());

  console.log(
    JSON.stringify(
      {
        ok: true,
        topupRates: DEFAULT_COIN_TRADING_TOPUP_RATES,
        exchangeRates: DEFAULT_AGENT_EXCHANGE_RATES,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
