/**
 * Simulate leave for a host by email — reports immediate vs approval path.
 * Usage: npx tsx scripts/simulate-host-leave.ts test@example.com
 */
import { PrismaClient } from "@prisma/client";
import { agencyHostService } from "../src/services/agencyHost.service";

const EMAIL = process.argv[2] ?? "test@example.com";
const prisma = new PrismaClient();

async function main() {
  const auth = await prisma.authIdentifier.findFirst({
    where: { provider: "email", identifier: EMAIL },
    include: { user: true },
  });
  if (!auth) throw new Error(`No user: ${EMAIL}`);

  const userId = auth.user.id;
  const membership = await prisma.agencyHost.findUnique({
    where: { hostUserId: userId },
  });
  if (!membership) throw new Error("Not a host");

  const faceProfile = await prisma.userFaceProfile.findUnique({
    where: { userId },
    select: { status: true },
  });
  const kyc = await prisma.agencyApplicationKyc.findUnique({
    where: { userId },
    select: { faceVerified: true },
  });

  const joinedMs = Date.now() - membership.joinedAt.getTime();
  const hoursInAgency = joinedMs / (60 * 60 * 1000);

  console.log(`User: ${EMAIL} (${userId})`);
  console.log(`joinedAt: ${membership.joinedAt.toISOString()}`);
  console.log(`tenure: ${hoursInAgency.toFixed(1)} hours (${(joinedMs / 86400000).toFixed(2)} days)`);
  console.log(`faceVerified (KYC): ${kyc?.faceVerified ?? false}`);
  console.log(`UserFaceProfile.status: ${faceProfile?.status ?? "none"}`);
  console.log(
    `Rule: <24h → immediate leave; ≥24h → PENDING leave + agency approval or 7d auto-approve`,
  );
  console.log(`Expected path: ${joinedMs < 24 * 60 * 60 * 1000 ? "IMMEDIATE" : "AGENCY_APPROVAL_OR_AUTO_7D"}`);
  console.log("\nCalling agencyHostService.applyToLeave...\n");

  const result = await agencyHostService.applyToLeave(userId, "Dev test leave");
  console.log("Result:", JSON.stringify(result, null, 2));

  const leaveRow = await prisma.agencyLeaveApplication.findFirst({
    where: { hostUserId: userId },
    orderBy: { createdAt: "desc" },
  });
  const stillHost = await prisma.agencyHost.findUnique({
    where: { hostUserId: userId },
  });
  console.log("\nStill in agency_hosts:", stillHost != null);
  if (leaveRow) {
    console.log("Leave application:", {
      id: leaveRow.id,
      status: leaveRow.status,
      autoApproveAt: leaveRow.autoApproveAt.toISOString(),
    });
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
