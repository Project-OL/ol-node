/**
 * Inspect a withdrawal and related payroll state.
 * Usage: npx tsx scripts/inspect-withdrawal.ts <withdrawalId>
 */
import "dotenv/config";
import { prisma } from "../src/config/database";

const withdrawalId = process.argv[2]?.trim();
if (!withdrawalId) {
  console.error("Usage: npx tsx scripts/inspect-withdrawal.ts <withdrawalId>");
  process.exit(1);
}

async function main() {
  const w = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: {
      payrollAssignments: {
        orderBy: { assignmentNumber: "asc" },
        include: {
          agencyUser: {
            select: {
              id: true,
              username: true,
              isAgent: true,
            },
          },
        },
      },
      paymentMethod: true,
      wallet: { select: { id: true } },
    },
  });

  if (!w) {
    console.error("Withdrawal not found:", withdrawalId);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { id: w.userId },
    select: { id: true, username: true, publicId: true },
  });

  const agencies = await prisma.agency.findMany({
    where: {},
    select: {
      userId: true,
      payrollEnabled: true,
      pausedAt: true,
      lastPayrollAssignedAt: true,
      user: { select: { username: true } },
    },
    orderBy: { lastPayrollAssignedAt: "asc" },
  });

  const debit = await prisma.pointLedgerEntry.findFirst({
    where: { idempotencyKey: `withdrawal-debit:${withdrawalId}` },
    select: {
      id: true,
      amount: true,
      direction: true,
      balanceAfter: true,
      createdAt: true,
    },
  });

  const refund = await prisma.pointLedgerEntry.findFirst({
    where: { idempotencyKey: `withdrawal-refund:${withdrawalId}` },
    select: { id: true, amount: true, createdAt: true },
  });

  console.log(
    JSON.stringify(
      {
        withdrawal: {
          id: w.id,
          userId: w.userId,
          username: user?.username,
          status: w.status,
          amountPoints: w.amountPoints.toString(),
          hostPayoutUsd: w.hostPayoutUsd?.toString(),
          assignmentCount: w.assignmentCount,
          requestedAt: w.requestedAt,
          processedAt: w.processedAt,
          failReason: w.failReason,
          paymentMethodType: w.paymentMethod?.methodType,
        },
        assignments: w.payrollAssignments.map((a) => ({
          id: a.id,
          assignmentNumber: a.assignmentNumber,
          status: a.status,
          agencyUserId: a.agencyUserId,
          agencyUsername: a.agencyUser.username,
          assignedAt: a.assignedAt,
          expiresAt: a.expiresAt,
          rejectedAt: a.rejectedAt,
          rejectionReason: a.rejectionReason,
        })),
        ledger: { debit, refund },
        eligibleAgencies: agencies.map((a) => ({
          userId: a.userId,
          username: a.user.username,
          payrollEnabled: a.payrollEnabled,
          paused: a.pausedAt != null,
          lastPayrollAssignedAt: a.lastPayrollAssignedAt,
        })),
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
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
