/**
 * One-time backfill for the withdrawal/payroll v2 escrow model.
 *
 * Existing withdrawals in PENDING / PENDING_PLATFORM were created with the
 * legacy `WITHDRAWAL` flow (a REAL ledger debit at create time). Their
 * grossPoints is already gone from the ledger sum (totalPoints), so they need
 * NO escrow tracking — `wallets.unconfirmedPoints` stays 0 for them.
 *
 * The migration's `withdrawal_version` column DEFAULT (1) already stamps every
 * pre-existing row as v1 (legacy real-debit), and `unconfirmed_points` defaults
 * to 0. So no data mutation is required — open v1 withdrawals must remain real
 * debits and need no escrow tracking. This script is therefore a diagnostic /
 * verification step: it reports open legacy volume and asserts the new
 * `unconfirmed_points` invariant holds before v2 traffic begins.
 *
 * Usage: npx tsx scripts/backfill-unconfirmed-points.ts
 */
import "dotenv/config";
import { prisma } from "../src/config/database";

async function main() {
  const openLegacy = await prisma.withdrawal.count({
    where: {
      status: { in: ["PENDING", "PENDING_PLATFORM"] },
      withdrawalVersion: 1,
    },
  });
  console.info(`Open v1 (PENDING/PENDING_PLATFORM) withdrawals: ${openLegacy}`);
  console.info(
    "  → these were real debits; unconfirmed_points stays 0 for them.",
  );

  const nonZeroUnconfirmed = await prisma.wallet.count({
    where: { currencyType: "POINT", unconfirmedPoints: { gt: 0n } },
  });
  console.info(`Wallets with unconfirmed_points > 0: ${nonZeroUnconfirmed}`);

  const v2Count = await prisma.withdrawal.count({
    where: { withdrawalVersion: 2 },
  });
  console.info(`v2 (escrow) withdrawals so far: ${v2Count}`);

  if (nonZeroUnconfirmed > 0 && v2Count === 0) {
    console.warn(
      "WARNING: unconfirmed_points is non-zero but no v2 withdrawals exist. Investigate.",
    );
  }

  console.info("\nBackfill verification complete. No data mutation required.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
