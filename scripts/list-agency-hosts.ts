import { PrismaClient } from "@prisma/client";

const AGENCY_PUBLIC_ID = 34216592n;
const prisma = new PrismaClient();

async function main() {
  const agency = await prisma.agency.findUnique({
    where: { defaultPublicId: AGENCY_PUBLIC_ID },
  });
  if (!agency) throw new Error("agency not found");

  const cancelled = await prisma.agencyHostApplication.updateMany({
    where: { agencyUserId: agency.userId, status: "PENDING" },
    data: { status: "CANCELLED", resolvedAt: new Date() },
  });
  if (cancelled.count > 0) {
    console.log(`Cancelled ${cancelled.count} stale PENDING join application(s)`);
  }

  const hosts = await prisma.agencyHost.findMany({
    where: { agencyUserId: agency.userId },
    include: { host: { select: { username: true, publicId: true } } },
    orderBy: { joinedAt: "asc" },
  });
  console.log(`Agency ${agency.displayName} — ${hosts.length} hosts:\n`);
  for (const h of hosts) {
    console.log(
      `  ${h.host.username.padEnd(16)} publicId=${h.host.publicId}  joined=${h.joinedAt.toISOString()}`,
    );
  }
}

main()
  .finally(() => prisma.$disconnect());
