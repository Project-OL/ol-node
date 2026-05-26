/**
 * Credit POINT wallet for a user by public id.
 * Usage: npx tsx scripts/grant-points-by-public-id.ts <publicId> [amount]
 */
import "dotenv/config";
import { PointTxType } from "@prisma/client";
import { prisma } from "../src/config/database";
import { pointWalletService } from "../src/services/point-wallet.service";

async function main() {
  const publicIdRaw = process.argv[2]?.trim();
  const amount = BigInt(process.argv[3] ?? "500000");
  const description = process.env.GRANT_DESCRIPTION ?? "Manual point grant";

  if (!publicIdRaw || !/^\d+$/.test(publicIdRaw)) {
    console.error("Usage: npx tsx scripts/grant-points-by-public-id.ts <publicId> [amount]");
    process.exit(1);
  }
  if (amount <= 0n) {
    console.error("Amount must be positive");
    process.exit(1);
  }

  const pid = BigInt(publicIdRaw);
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ publicId: pid }, { defaultPublicId: pid }, { currentVipPublicId: pid }],
    },
    select: { id: true, username: true, publicId: true },
  });

  if (!user) {
    console.error(`No user found for publicId: ${publicIdRaw}`);
    process.exit(1);
  }

  const entry = await pointWalletService.creditPoints({
    userId: user.id,
    amount,
    txType: PointTxType.ADJUSTMENT,
    description,
    idempotencyKey: `grant-points-manual:${user.id}:${Date.now()}`,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        publicId: user.publicId.toString(),
        username: user.username,
        userId: user.id,
        credited: amount.toString(),
        balanceAfter: entry.balanceAfter.toString(),
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
