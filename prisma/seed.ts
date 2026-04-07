import { LevelType, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Shared curve for WEALTH (coin credits) and LIVESTREAM (point credits). Monotonic thresholds. */
const THRESHOLDS: { level: number; threshold: bigint }[] = [
  { level: 1, threshold: 0n },
  { level: 2, threshold: 3_000n },
  { level: 3, threshold: 6_000n },
  { level: 4, threshold: 16_000n },
  { level: 5, threshold: 66_000n },
  { level: 6, threshold: 166_000n },
  { level: 7, threshold: 330_000n },
  { level: 8, threshold: 500_000n },
  { level: 9, threshold: 700_000n },
  { level: 10, threshold: 1_000_000n },
  { level: 11, threshold: 1_100_000n },
  { level: 12, threshold: 1_300_000n },
  { level: 13, threshold: 1_600_000n },
  { level: 14, threshold: 2_000_000n },
  { level: 15, threshold: 3_000_000n },
  { level: 16, threshold: 5_000_000n },
  { level: 17, threshold: 8_000_000n },
  { level: 18, threshold: 12_000_000n },
  { level: 19, threshold: 18_000_000n },
  { level: 20, threshold: 26_000_000n },
  { level: 21, threshold: 36_000_000n },
  { level: 22, threshold: 48_000_000n },
  { level: 23, threshold: 62_000_000n },
  { level: 24, threshold: 78_000_000n },
  { level: 25, threshold: 96_000_000n },
  { level: 26, threshold: 108_000_000n },
  { level: 27, threshold: 118_000_000n },
  { level: 28, threshold: 126_000_000n },
  { level: 29, threshold: 132_000_000n },
  { level: 30, threshold: 136_000_000n },
  { level: 31, threshold: 139_000_000n },
  { level: 32, threshold: 141_000_000n },
  { level: 33, threshold: 143_000_000n },
  { level: 34, threshold: 145_000_000n },
  { level: 35, threshold: 147_000_000n },
  { level: 36, threshold: 149_000_000n },
  { level: 37, threshold: 150_000_000n },
  { level: 38, threshold: 150_500_000n },
  { level: 39, threshold: 165_000_000n },
  { level: 40, threshold: 200_000_000n },
  { level: 41, threshold: 250_000_000n },
  { level: 42, threshold: 310_000_000n },
  { level: 43, threshold: 380_000_000n },
  { level: 44, threshold: 460_000_000n },
  { level: 45, threshold: 550_000_000n },
  { level: 46, threshold: 650_000_000n },
  { level: 47, threshold: 800_000_000n },
  { level: 48, threshold: 1_000_000_000n },
  { level: 49, threshold: 1_400_000_000n },
  { level: 50, threshold: 2_000_000_000n },
];

async function main() {
  await prisma.coinPackage.createMany({
    data: [
      { coins: 8_500, priceCents: 299, label: null, sortOrder: 1 },
      { coins: 18_500, priceCents: 599, label: null, sortOrder: 2 },
      { coins: 68_000, priceCents: 1999, label: "Popular", sortOrder: 3 },
      { coins: 198_000, priceCents: 4999, label: null, sortOrder: 4 },
    ],
    skipDuplicates: true,
  });

  for (const levelType of [LevelType.WEALTH, LevelType.LIVESTREAM]) {
    await prisma.walletLevelConfig.createMany({
      data: THRESHOLDS.map((t) => ({
        levelType,
        level: t.level,
        threshold: t.threshold,
        isActive: true,
      })),
      skipDuplicates: true,
    });
  }
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
