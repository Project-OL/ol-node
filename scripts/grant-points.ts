/**
 * Credit POINT wallet for a user by email.
 * Usage: npx tsx scripts/grant-points.ts use22322r@example.com 10000000
 */
import "dotenv/config";
import { PointTxType } from "@prisma/client";
import { prisma } from "../src/config/database";
import { pointWalletService } from "../src/services/point-wallet.service";

async function main() {
  const email = (process.argv[2] ?? "use22322r@example.com").trim().toLowerCase();
  const amount = BigInt(process.argv[3] ?? "10000000");
  const description = process.env.GRANT_DESCRIPTION ?? "Manual point grant";

  if (amount <= 0n) {
    console.error("Amount must be positive");
    process.exit(1);
  }

  const auth = await prisma.authIdentifier.findFirst({
    where: {
      provider: "email",
      identifier: { equals: email, mode: "insensitive" },
    },
    select: { userId: true },
  });
  if (!auth) {
    console.error(`No user found for email: ${email}`);
    process.exit(1);
  }

  const entry = await pointWalletService.creditPoints({
    userId: auth.userId,
    amount,
    txType: PointTxType.ADJUSTMENT,
    description,
    idempotencyKey: `grant-points-manual:${auth.userId}:${Date.now()}`,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        email,
        userId: auth.userId,
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
