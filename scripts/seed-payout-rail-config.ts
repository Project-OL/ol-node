/**
 * Seed or update withdrawal payout rail config (EPAY/BANK fee + arrival copy).
 * Usage: npx tsx scripts/seed-payout-rail-config.ts
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { withdrawalPayoutRailConfigService } from "../src/services/withdrawalPayoutRailConfig.service";

/** Product defaults — adjust here or use admin PUT /admin/agency/withdrawal/payout-rails */
const CONFIG = {
  epay: {
    feeRateBp: 600,
    arrivalTime: "Within 24 hours",
  },
  bank: {
    feeRateBp: 600,
    arrivalTime: "3-5 business days",
  },
} as const;

async function main() {
  await prisma.withdrawalPayoutRailConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      epayFeeRateBp: CONFIG.epay.feeRateBp,
      epayArrivalTime: CONFIG.epay.arrivalTime,
      bankFeeRateBp: CONFIG.bank.feeRateBp,
      bankArrivalTime: CONFIG.bank.arrivalTime,
    },
    update: {
      epayFeeRateBp: CONFIG.epay.feeRateBp,
      epayArrivalTime: CONFIG.epay.arrivalTime,
      bankFeeRateBp: CONFIG.bank.feeRateBp,
      bankArrivalTime: CONFIG.bank.arrivalTime,
    },
  });

  await withdrawalPayoutRailConfigService.bustCache();
  const config = await withdrawalPayoutRailConfigService.getPublicConfig();
  console.log(JSON.stringify(config, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
