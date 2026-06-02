/**
 * Dev/QA: inspect why an agent's payroll summary shows N completed but period
 * earnings for fewer. Lists completed assignments (completedAt, withdrawalVersion,
 * hostPayoutUsd) and the agent's PAYROLL_* ledger credits.
 *
 * Usage:
 *   npx tsx scripts/inspect-agent-payroll-summary.ts <agencyUserId>
 *   npx tsx scripts/inspect-agent-payroll-summary.ts fbc0640d-05b0-4df9-a9bb-266eb5a0484b
 */
import "dotenv/config";
import { prisma } from "../src/config/database";

const DEFAULT_AGENT = "fbc0640d-05b0-4df9-a9bb-266eb5a0484b";

async function main() {
  const agencyUserId = (process.argv[2] ?? DEFAULT_AGENT).trim();

  const assignments = await prisma.withdrawalPayrollAssignment.findMany({
    where: { agencyUserId, status: "COMPLETED" },
    orderBy: { completedAt: "asc" },
    select: {
      id: true,
      status: true,
      completedAt: true,
      withdrawalId: true,
      withdrawal: {
        select: {
          id: true,
          status: true,
          withdrawalVersion: true,
          hostPayoutUsd: true,
          amountPoints: true,
          agentRewardPoints: true,
        },
      },
    },
  });

  console.log(`Completed assignments for agent ${agencyUserId}: ${assignments.length}\n`);
  for (const a of assignments) {
    console.log("---");
    console.log(`assignmentId:      ${a.id}`);
    console.log(`completedAt:       ${a.completedAt?.toISOString() ?? "(null)"}`);
    console.log(`withdrawalId:      ${a.withdrawalId}`);
    console.log(`withdrawal.status: ${a.withdrawal?.status}`);
    console.log(`withdrawalVersion: ${a.withdrawal?.withdrawalVersion}`);
    console.log(`hostPayoutUsd:     ${a.withdrawal?.hostPayoutUsd?.toString() ?? "(null)"}`);
    console.log(`amountPoints:      ${a.withdrawal?.amountPoints?.toString() ?? "(null)"}`);
    console.log(`agentRewardPoints: ${a.withdrawal?.agentRewardPoints?.toString() ?? "(null)"}`);
  }

  const wallet = await prisma.wallet.findFirst({
    where: { userId: agencyUserId, currencyType: "POINT" },
    select: { id: true },
  });

  if (wallet) {
    const credits = await prisma.pointLedgerEntry.findMany({
      where: {
        walletId: wallet.id,
        direction: "CREDIT",
        txType: { in: ["PAYROLL_HOST_PAYOUT", "PAYROLL_PROCESSING_REWARD"] },
      },
      orderBy: { createdAt: "asc" },
      select: { txType: true, amount: true, refId: true, createdAt: true },
    });
    console.log(`\nPAYROLL_* credit ledger entries: ${credits.length}\n`);
    for (const c of credits) {
      console.log(
        `  ${c.createdAt.toISOString()}  ${c.txType.padEnd(26)} +${c.amount.toString().padEnd(6)} refId=${c.refId ?? "(null)"}`,
      );
    }
  } else {
    console.log("\nNo POINT wallet found for agent.");
  }
}

main()
  .catch((err) => {
    console.error("\nFailed:", err?.code ?? "", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
