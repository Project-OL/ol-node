/**
 * One-off: credit TRADING_COIN ledger for a user (by primary email).
 *
 * Usage:
 *   npx tsx scripts/grant-trading-coins.ts use22322r@example.com 100000
 *
 * Env: DATABASE_URL (via .env). Optional description defaults to "cto added coins".
 *
 * Does not require the user to be an agent — adjusts the TRADING_COIN wallet only.
 */
import "dotenv/config";
import { CoinTxType, LedgerDirection, WalletCurrencyType } from "@prisma/client";
import { prisma } from "../src/config/database";
import { redisClient, RedisKeys } from "../src/config/redis";
import { coinLedgerRepository } from "../src/repositories/coin-ledger.repository";
import { walletRepository } from "../src/repositories/wallet.repository";

const TX_TIMEOUT_MS = 20_000;

async function main() {
  const emailArg = process.argv[2] ?? "use22322r@example.com";
  const amountArg = process.argv[3] ?? "100000";
  const description = process.env.GRANT_DESCRIPTION ?? "cto added coins";

  const email = emailArg.trim().toLowerCase();
  const amount = BigInt(amountArg);
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

  const userId = auth.userId;
  const idempotencyKey = `grant-trading-manual:${userId}:${Date.now()}`;

  await prisma.$transaction(
    async (tx) => {
      const wallet = await walletRepository.getOrCreate(userId, WalletCurrencyType.TRADING_COIN);
      await walletRepository.lockForUpdate(tx, wallet.id);
      const last = await tx.coinLedgerEntry.findFirst({
        where: { walletId: wallet.id },
        orderBy: { createdAt: "desc" },
        select: { balanceAfter: true },
      });
      const balance = last?.balanceAfter ?? 0n;
      await coinLedgerRepository.insert(tx, {
        walletId: wallet.id,
        direction: LedgerDirection.CREDIT,
        txType: CoinTxType.ADJUSTMENT,
        amount,
        balanceAfter: balance + amount,
        description,
        idempotencyKey,
      });
      await walletRepository.bumpVersion(tx, wallet.id);
    },
    { isolationLevel: "Serializable", timeout: TX_TIMEOUT_MS },
  );

  await redisClient.del(RedisKeys.ctBalance(userId));

  console.info(`OK: credited ${amount} TRADING_COIN to userId=${userId} (${email}). Description="${description}"`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
