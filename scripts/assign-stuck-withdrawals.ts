import { PrismaClient } from "@prisma/client";
import { withdrawalService } from "../src/services/withdrawal.service";
import { agencyRepository } from "../src/repositories/agency.repository";

const AGENT_PUBLIC_ID = 34216632n;

async function main() {
  const prisma = new PrismaClient();

  const agency = await agencyRepository.getAgencyByPublicId(AGENT_PUBLIC_ID);
  if (!agency) {
    throw new Error(`No agency found for publicId ${AGENT_PUBLIC_ID}`);
  }

  const agent = await prisma.user.findUnique({
    where: { id: agency.userId },
    select: { username: true, publicId: true },
  });

  console.log(
    `Target agent: ${agency.userId} (${agent?.username}, publicId ${agent?.publicId})`,
  );

  const stuck = await prisma.withdrawal.findMany({
    where: { status: "PENDING_PLATFORM" },
    orderBy: { requestedAt: "asc" },
    select: {
      id: true,
      userId: true,
      status: true,
      requestedAt: true,
      hostPayoutUsd: true,
      assignmentCount: true,
    },
  });

  console.log(`Found ${stuck.length} PENDING_PLATFORM withdrawal(s)\n`);

  if (!stuck.length) {
    await prisma.$disconnect();
    return;
  }

  for (const w of stuck) {
    await withdrawalService.assignToAgency(w.id, {
      overrideAgencyUserId: agency.userId,
      allowBeyondAssignmentCap: true,
    });

    const updated = await prisma.withdrawal.findUnique({
      where: { id: w.id },
      include: {
        payrollAssignments: {
          where: { status: "PENDING" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            agencyUserId: true,
            expiresAt: true,
            assignmentNumber: true,
          },
        },
      },
    });

    const assignment = updated?.payrollAssignments[0];
    console.log({
      withdrawalId: w.id,
      newStatus: updated?.status,
      assignmentId: assignment?.id ?? null,
      assignmentNumber: assignment?.assignmentNumber ?? null,
      expiresAt: assignment?.expiresAt?.toISOString() ?? null,
      ok: updated?.status === "PENDING" && assignment?.agencyUserId === agency.userId,
    });
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
