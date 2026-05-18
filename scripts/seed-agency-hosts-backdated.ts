/**
 * Dev seed: add hosts to an agency with backdated joined_at (1–7 days).
 * Usage: npx tsx scripts/seed-agency-hosts-backdated.ts
 */
import { PrismaClient } from "@prisma/client";

const AGENCY_PUBLIC_ID = 34216592n;

/** public_id → days ago joined */
const HOSTS: { publicId: bigint; daysAgo: number; message?: string }[] = [
  { publicId: 34216625n, daysAgo: 1, message: "Seed host — joined 1d ago" },
  { publicId: 34216641n, daysAgo: 2, message: "Seed host — joined 2d ago" },
  { publicId: 34216589n, daysAgo: 3, message: "Seed host — joined 3d ago" },
  { publicId: 34216608n, daysAgo: 5, message: "Seed host — joined 5d ago" },
  { publicId: 34216603n, daysAgo: 7, message: "Seed host — joined 7d ago" },
];

const prisma = new PrismaClient();

function daysAgoDate(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

async function main() {
  const agency = await prisma.agency.findUnique({
    where: { defaultPublicId: AGENCY_PUBLIC_ID },
    select: { userId: true, displayName: true, totalHostsCount: true },
  });
  if (!agency) {
    throw new Error(`Agency ${AGENCY_PUBLIC_ID} not found`);
  }
  const agencyUserId = agency.userId;
  console.log(`Agency: ${agency.displayName} (${agencyUserId})`);

  let added = 0;
  for (const spec of HOSTS) {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { publicId: spec.publicId },
          { defaultPublicId: spec.publicId },
          { currentVipPublicId: spec.publicId },
        ],
      },
      select: {
        id: true,
        username: true,
        publicId: true,
        isAgent: true,
        currentAgencyId: true,
      },
    });

    if (!user) {
      console.warn(`Skip ${spec.publicId}: user not found`);
      continue;
    }
    if (user.isAgent) {
      console.warn(`Skip ${user.username} (${spec.publicId}): is agent`);
      continue;
    }
    if (user.currentAgencyId) {
      console.warn(
        `Skip ${user.username}: already in agency ${user.currentAgencyId}`,
      );
      continue;
    }

    const existingHost = await prisma.agencyHost.findUnique({
      where: { hostUserId: user.id },
    });
    if (existingHost) {
      console.warn(`Skip ${user.username}: already agency_hosts row`);
      continue;
    }

    const joinedAt = daysAgoDate(spec.daysAgo);

    await prisma.$transaction(async (tx) => {
      await tx.agencyHostApplication.create({
        data: {
          agencyUserId,
          hostUserId: user.id,
          status: "ACCEPTED",
          message: spec.message,
          resolvedAt: joinedAt,
          resolvedByUserId: null,
          createdAt: joinedAt,
        },
      });
      await tx.agencyHost.create({
        data: {
          agencyUserId,
          hostUserId: user.id,
          joinedAt,
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { currentAgencyId: agencyUserId },
      });
    });

    console.log(
      `Added host ${user.username} (publicId ${user.publicId}) joined ${spec.daysAgo}d ago @ ${joinedAt.toISOString()}`,
    );
    added++;
  }

  const hostCount = await prisma.agencyHost.count({
    where: { agencyUserId },
  });
  await prisma.agency.update({
    where: { userId: agencyUserId },
    data: { totalHostsCount: hostCount },
  });

  console.log(`Done. Added ${added} hosts. total_hosts_count = ${hostCount}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
