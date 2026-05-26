/**
 * Cancel/delete a withdrawal and refund debited points (dev/support).
 * Usage: npx tsx scripts/delete-withdrawal.ts <withdrawalId> [--hard]
 */
import "dotenv/config";
import { PointTxType, WithdrawalStatus } from "@prisma/client";
import { prisma } from "../src/config/database";
import { pointWalletService } from "../src/services/point-wallet.service";
import { walletService } from "../src/services/wallet.service";
import { removePayrollSla } from "../src/queues/payroll.queue";

const withdrawalId = process.argv[2]?.trim();
const hardDelete = process.argv.includes("--hard");

async function main() {
  if (!withdrawalId) {
    console.error("Usage: npx tsx scripts/delete-withdrawal.ts <withdrawalId> [--hard]");
    process.exit(1);
  }

  const w = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: { payrollAssignments: true },
  });

  if (!w) {
    console.error(`Withdrawal not found: ${withdrawalId}`);
    process.exit(1);
  }

  console.log("Found withdrawal:", {
    id: w.id,
    userId: w.userId,
    status: w.status,
    amountPoints: w.amountPoints.toString(),
    assignments: w.payrollAssignments.map((a) => ({
      id: a.id,
      status: a.status,
      agencyUserId: a.agencyUserId,
    })),
  });

  if (w.status === WithdrawalStatus.PAID || w.status === WithdrawalStatus.DISPUTED) {
    console.error(
      "Withdrawal is PAID/DISPUTED — use admin POST /admin/agency/withdrawal/:id/reverse instead.",
    );
    process.exit(1);
  }

  if (w.status === WithdrawalStatus.FAILED) {
    if (hardDelete) {
      for (const a of w.payrollAssignments) {
        await removePayrollSla(a.id).catch(() => undefined);
      }
      await prisma.withdrawal.delete({ where: { id: withdrawalId } });
      console.log("Hard-deleted FAILED withdrawal row.");
      return;
    }
    console.log("Already FAILED; pass --hard to remove the row.");
    return;
  }

  const pendingAssignments = w.payrollAssignments.filter((a) => a.status === "PENDING");
  for (const a of pendingAssignments) {
    await removePayrollSla(a.id).catch(() => undefined);
  }

  await prisma.$transaction(
    async (tx) => {
      await pointWalletService.creditInTransaction(
        w.userId,
        w.amountPoints,
        PointTxType.WITHDRAWAL_REFUND,
        tx,
        {
          idempotencyKey: `withdrawal-refund:${withdrawalId}`,
          refId: withdrawalId,
          description: "Withdrawal cancelled (manual delete)",
          applyLivestreamLevel: false,
        },
      );

      if (hardDelete) {
        await tx.withdrawalPayrollAssignment.deleteMany({
          where: { withdrawalId },
        });
        await tx.withdrawal.delete({ where: { id: withdrawalId } });
      } else {
        await tx.withdrawal.update({
          where: { id: withdrawalId },
          data: {
            status: WithdrawalStatus.FAILED,
            failReason: "Cancelled manually",
            processedAt: new Date(),
          },
        });
        await tx.withdrawalPayrollAssignment.updateMany({
          where: { withdrawalId, status: "PENDING" },
          data: {
            status: "REJECTED",
            rejectedAt: new Date(),
            rejectionReason: "Withdrawal cancelled",
          },
        });
      }
    },
    { isolationLevel: "Serializable", timeout: 20_000 },
  );

  await walletService.adjustPointBalanceCache(w.userId, w.amountPoints);

  console.log(
    hardDelete
      ? `Deleted withdrawal ${withdrawalId} and refunded ${w.amountPoints.toString()} points.`
      : `Cancelled withdrawal ${withdrawalId} (FAILED) and refunded ${w.amountPoints.toString()} points.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
