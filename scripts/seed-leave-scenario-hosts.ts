/**
 * Seed 3 hosts under agency 34216592 for leave-flow QA:
 * A) face verified + joined >24h → PENDING leave (approval path)
 * B) no face + joined >24h → immediate leave
 * C) no face + joined <24h → immediate leave
 *
 * Usage: npx tsx scripts/seed-leave-scenario-hosts.ts
 */
import { PrismaClient } from "@prisma/client";

const AGENCY_PUBLIC_ID = 34216592n;
const DEV_COLLECTION = "dev-leave-test-collection";

type Scenario = {
  label: string;
  publicId: bigint;
  joinedAt: Date;
  faceVerified: boolean;
};

function daysAgoAtNoon(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

const SCENARIOS: Scenario[] = [
  {
    label: "A_verified_over_24h",
    publicId: 34216589n, // user@example.com — Andrea
    joinedAt: daysAgoAtNoon(4),
    faceVerified: true,
  },
  {
    label: "B_unverified_over_24h",
    publicId: 34216608n, // user_000000
    joinedAt: daysAgoAtNoon(5),
    faceVerified: false,
  },
  {
    label: "C_unverified_under_24h",
    publicId: 34216625n, // user_222222
    joinedAt: hoursAgo(12),
    faceVerified: false,
  },
];

const prisma = new PrismaClient();

async function ensureHostInAgency(params: {
  agencyUserId: string;
  userId: string;
  joinedAt: Date;
  message: string;
}) {
  const existing = await prisma.agencyHost.findUnique({
    where: { hostUserId: params.userId },
  });

  if (existing) {
    if (existing.agencyUserId !== params.agencyUserId) {
      throw new Error(`User ${params.userId} is host of another agency`);
    }
    await prisma.agencyHost.update({
      where: { hostUserId: params.userId },
      data: { joinedAt: params.joinedAt },
    });
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.agencyHostApplication.create({
        data: {
          agencyUserId: params.agencyUserId,
          hostUserId: params.userId,
          status: "ACCEPTED",
          message: params.message,
          resolvedAt: params.joinedAt,
          resolvedByUserId: null,
          createdAt: params.joinedAt,
        },
      });
      await tx.agencyHost.create({
        data: {
          agencyUserId: params.agencyUserId,
          hostUserId: params.userId,
          joinedAt: params.joinedAt,
        },
      });
      await tx.user.update({
        where: { id: params.userId },
        data: { currentAgencyId: params.agencyUserId },
      });
    });
  }

  await prisma.agencyLeaveApplication.updateMany({
    where: { hostUserId: params.userId, status: "PENDING" },
    data: { status: "CANCELLED", resolvedAt: new Date() },
  });
}

async function setFaceVerified(userId: string, verified: boolean) {
  if (verified) {
    await prisma.userFaceProfile.upsert({
      where: { userId },
      create: {
        userId,
        collectionId: DEV_COLLECTION,
        s3KeyReference: `dev/face/${userId}/reference.jpg`,
        status: "INDEXED",
        indexedAt: new Date(),
      },
      update: {
        status: "INDEXED",
        indexedAt: new Date(),
        revokedAt: null,
        failureReason: null,
      },
    });
    await prisma.agencyApplicationKyc.upsert({
      where: { userId },
      create: { userId, faceVerified: true },
      update: { faceVerified: true },
    });
  } else {
    await prisma.userFaceProfile.deleteMany({ where: { userId } });
    await prisma.agencyApplicationKyc.updateMany({
      where: { userId },
      data: { faceVerified: false },
    });
  }
}

async function main() {
  const agency = await prisma.agency.findUnique({
    where: { defaultPublicId: AGENCY_PUBLIC_ID },
  });
  if (!agency) throw new Error("Agency 34216592 not found");

  console.log(`Agency: ${agency.displayName} (${agency.userId})\n`);

  for (const s of SCENARIOS) {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { publicId: s.publicId },
          { defaultPublicId: s.publicId },
        ],
      },
      include: {
        authIdentifiers: { where: { isPrimary: true }, take: 1 },
      },
    });
    if (!user) {
      console.warn(`SKIP ${s.label}: no user for publicId ${s.publicId}`);
      continue;
    }
    if (user.isAgent) {
      console.warn(`SKIP ${s.label}: user is agent`);
      continue;
    }

    await ensureHostInAgency({
      agencyUserId: agency.userId,
      userId: user.id,
      joinedAt: s.joinedAt,
      message: `Leave QA: ${s.label}`,
    });
    await setFaceVerified(user.id, s.faceVerified);

    const tenureH = (Date.now() - s.joinedAt.getTime()) / 3600000;
    const expected =
      tenureH < 24 || !s.faceVerified
        ? "IMMEDIATE on POST /leave-applications"
        : "PENDING (agency approval / 7d auto)";

    const loginId =
      user.authIdentifiers[0]?.identifier ?? user.publicId.toString();

    console.log(`--- ${s.label} ---`);
    console.log(`  username: ${user.username}`);
    console.log(`  userId: ${user.id}`);
    console.log(`  publicId: ${user.publicId}`);
    console.log(`  login: ${user.authIdentifiers[0]?.provider ?? "?"} → ${loginId}`);
    console.log(`  password: ValidPass1! (dev)`);
    console.log(`  joinedAt: ${s.joinedAt.toISOString()} (${tenureH.toFixed(1)}h ago)`);
    console.log(`  faceVerified: ${s.faceVerified}`);
    console.log(`  expected leave: ${expected}\n`);
  }

  const count = await prisma.agencyHost.count({
    where: { agencyUserId: agency.userId },
  });
  await prisma.agency.update({
    where: { userId: agency.userId },
    data: { totalHostsCount: count },
  });
  console.log(`total_hosts_count = ${count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
