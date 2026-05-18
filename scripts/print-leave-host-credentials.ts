import { PrismaClient } from "@prisma/client";

const HOSTS = [
  {
    scenario: "A — Face verified, >24h (approval path)",
    id: "1e7d864a-6730-4562-8563-8c0a2aece85b",
  },
  {
    scenario: "B — No face, >24h (immediate leave)",
    id: "2fc988aa-2ed5-4bfc-8400-cda4c175199b",
  },
  {
    scenario: "C — No face, <24h (immediate leave)",
    id: "0b091517-3365-4c9e-ae2a-0a02f0425f66",
  },
];

const prisma = new PrismaClient();

async function main() {
  for (const h of HOSTS) {
    const u = await prisma.user.findUnique({
      where: { id: h.id },
      include: {
        authIdentifiers: { orderBy: [{ isPrimary: "desc" }, { provider: "asc" }] },
        agencyHost: true,
      },
    });
    const fp = await prisma.userFaceProfile.findUnique({
      where: { userId: h.id },
      select: { status: true },
    });
    if (!u) continue;
    const primary =
      u.authIdentifiers.find((a) => a.isPrimary) ?? u.authIdentifiers[0];
    console.log(h.scenario);
    console.log(`  username: ${u.username}`);
    console.log(`  publicId: ${u.publicId}`);
    console.log(`  provider: ${primary?.provider}`);
    console.log(`  identifier: ${primary?.identifier}`);
    console.log(`  password: ValidPass1!`);
    console.log(`  joinedAt: ${u.agencyHost?.joinedAt?.toISOString() ?? "n/a"}`);
    console.log(`  face: ${fp?.status ?? "none"}`);
    console.log("");
  }
}

main().finally(() => prisma.$disconnect());
