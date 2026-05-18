import { PrismaClient } from "@prisma/client";

const HOST_IDS = [
  "0b091517-3365-4c9e-ae2a-0a02f0425f66",
  "3d18e6be-4e56-4dbe-97bd-c6bf25b4dde8",
  "1e7d864a-6730-4562-8563-8c0a2aece85b",
  "2fc988aa-2ed5-4bfc-8400-cda4c175199b",
  "32116940-259c-47c7-8298-e06912ea114e",
];

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { id: { in: HOST_IDS } },
    select: {
      id: true,
      username: true,
      publicId: true,
      defaultPublicId: true,
      passwordSet: true,
      authIdentifiers: {
        select: { provider: true, identifier: true, isPrimary: true },
        orderBy: [{ isPrimary: "desc" }, { provider: "asc" }],
      },
      authPassword: { select: { id: true } },
    },
  });

  for (const id of HOST_IDS) {
    const u = users.find((x) => x.id === id);
    if (!u) {
      console.log(`\n--- ${id} --- NOT FOUND`);
      continue;
    }
    console.log(`\n--- ${u.username} (${id}) ---`);
    console.log(`  publicId: ${u.publicId}`);
    console.log(`  passwordSet: ${u.passwordSet}`);
    console.log(`  hasAuthPassword row: ${u.authPassword != null}`);
    for (const ai of u.authIdentifiers) {
      console.log(
        `  ${ai.provider}${ai.isPrimary ? " (primary)" : ""}: ${ai.identifier}`,
      );
    }
  }
}

main()
  .finally(() => prisma.$disconnect());
