/**
 * Dev/QA: set a payroll assignment's expiresAt to N hours from now.
 *
 * Usage:
 *   npx tsx scripts/set-assignment-expiry.ts <assignmentId> [hoursFromNow]
 *   npx tsx scripts/set-assignment-expiry.ts f919b159-c13c-4dec-bb7f-668a337e20d3 2
 */
import "dotenv/config";
import { prisma } from "../src/config/database";

async function main() {
  const assignmentId = process.argv[2]?.trim();
  const hours = Number(process.argv[3] ?? "2");
  if (!assignmentId) {
    console.error("Usage: npx tsx scripts/set-assignment-expiry.ts <assignmentId> [hoursFromNow]");
    process.exit(1);
  }

  const before = await prisma.withdrawalPayrollAssignment.findUnique({
    where: { id: assignmentId },
    select: { id: true, status: true, agencyUserId: true, expiresAt: true },
  });
  if (!before) {
    console.error(`Assignment not found: ${assignmentId}`);
    process.exit(1);
  }

  const newExpiry = new Date(Date.now() + hours * 60 * 60 * 1000);
  const updated = await prisma.withdrawalPayrollAssignment.update({
    where: { id: assignmentId },
    data: { expiresAt: newExpiry },
    select: { id: true, status: true, agencyUserId: true, expiresAt: true },
  });

  console.log("Before:", JSON.stringify({ ...before, expiresAt: before.expiresAt.toISOString() }, null, 2));
  console.log("After: ", JSON.stringify({ ...updated, expiresAt: updated.expiresAt.toISOString() }, null, 2));
}

main()
  .catch((err) => {
    console.error("\nFailed:", err?.code ?? "", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
