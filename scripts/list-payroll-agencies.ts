import "dotenv/config";
import { prisma } from "../src/config/database";

async function main() {
  const rows = await prisma.agency.findMany({
    where: { payrollEnabled: true },
    orderBy: { displayName: "asc" },
    select: {
      userId: true,
      defaultPublicId: true,
      displayName: true,
      payrollEnabled: true,
      pausedAt: true,
      totalHostsCount: true,
      createdAt: true,
      user: {
        select: {
          username: true,
          publicId: true,
        },
      },
    },
  });

  for (const r of rows) {
    console.log(
      [
        r.displayName,
        `owner=${r.user.username}`,
        `publicId=${r.user.publicId}`,
        `agencyPublicId=${r.defaultPublicId}`,
        `hosts=${r.totalHostsCount}`,
        r.pausedAt ? "PAUSED" : "active",
      ].join(" | "),
    );
  }
  console.log(`\nTotal agencies with payroll on: ${rows.length}`);
  const total = await prisma.agency.count();
  const off = await prisma.agency.count({ where: { payrollEnabled: false } });
  console.log(`Total agencies: ${total} (payroll off: ${off})`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
