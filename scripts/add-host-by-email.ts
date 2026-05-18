import { PrismaClient } from "@prisma/client";

const EMAIL = process.argv[2] ?? "test@example.com";
const AGENCY_PUBLIC_ID = BigInt(process.argv[3] ?? "34216592");
const DAYS_AGO = Number(process.argv[4] ?? "3");

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
  });
  if (!agency) throw new Error("Agency not found");

  const auth = await prisma.authIdentifier.findFirst({
    where: { provider: "email", identifier: EMAIL },
    include: { user: true },
  });
  if (!auth) throw new Error(`No user with email ${EMAIL}`);

  const user = auth.user;
  const joinedAt = daysAgoDate(DAYS_AGO);

  const existing = await prisma.agencyHost.findUnique({
    where: { hostUserId: user.id },
  });

  if (existing) {
    if (existing.agencyUserId !== agency.userId) {
      throw new Error(
        `User already host of another agency ${existing.agencyUserId}`,
      );
    }
    await prisma.agencyHost.update({
      where: { hostUserId: user.id },
      data: { joinedAt },
    });
    console.log(`Updated joined_at for ${EMAIL} → ${joinedAt.toISOString()}`);
    return;
  }

  if (user.isAgent) throw new Error("User is an agent");
  if (user.currentAgencyId && user.currentAgencyId !== agency.userId) {
    throw new Error(`User currentAgencyId=${user.currentAgencyId}`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.agencyHostApplication.create({
      data: {
        agencyUserId: agency.userId,
        hostUserId: user.id,
        status: "ACCEPTED",
        message: `Seed host — joined ${DAYS_AGO}d ago`,
        resolvedAt: joinedAt,
        resolvedByUserId: null,
        createdAt: joinedAt,
      },
    });
    await tx.agencyHost.create({
      data: { agencyUserId: agency.userId, hostUserId: user.id, joinedAt },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { currentAgencyId: agency.userId },
    });
  });

  const count = await prisma.agencyHost.count({
    where: { agencyUserId: agency.userId },
  });
  await prisma.agency.update({
    where: { userId: agency.userId },
    data: { totalHostsCount: count },
  });

  console.log(
    `Added ${EMAIL} (${user.id}) joined ${joinedAt.toISOString()}, totalHosts=${count}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
