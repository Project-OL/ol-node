import { PrismaClient } from "@prisma/client";
import { prismaRead } from "../src/config/database";
import { agencyHostRepository } from "../src/repositories/agencyHost.repository";

const EMAIL = "test@example.com";
const IMMEDIATE_LEAVE_MS = 24 * 60 * 60 * 1000;
const prisma = new PrismaClient();

async function main() {
  const auth = await prisma.authIdentifier.findFirst({
    where: { provider: "email", identifier: EMAIL },
  });
  if (!auth) throw new Error("no user");

  const writeRow = await prisma.agencyHost.findUnique({
    where: { hostUserId: auth.userId },
  });
  const readRow = await agencyHostRepository.getHost(auth.userId);

  const face = await prisma.userFaceProfile.findUnique({
    where: { userId: auth.userId },
  });

  for (const [label, row] of [
    ["writer", writeRow],
    ["reader", readRow],
  ] as const) {
    if (!row) {
      console.log(`${label}: no membership`);
      continue;
    }
    const joinedMs = Date.now() - row.joinedAt.getTime();
    console.log(`${label} joinedAt=${row.joinedAt.toISOString()} tenureHours=${(joinedMs / 3600000).toFixed(2)} immediate=${joinedMs < IMMEDIATE_LEAVE_MS}`);
  }

  console.log(`face profile: ${face?.status ?? "none"}`);
  console.log("\nCode: applyToLeave does NOT check face verification.");
  console.log("≥24h tenure → PENDING leave + autoApproveAt +7d (agency can accept sooner)");
}

main()
  .finally(() => prisma.$disconnect());
