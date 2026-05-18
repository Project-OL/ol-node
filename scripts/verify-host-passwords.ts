import { PrismaClient } from "@prisma/client";
import { passwordService } from "../src/services/password.service";

const HOST_IDS = [
  "0b091517-3365-4c9e-ae2a-0a02f0425f66",
  "3d18e6be-4e56-4dbe-97bd-c6bf25b4dde8",
  "1e7d864a-6730-4562-8563-8c0a2aece85b",
  "2fc988aa-2ed5-4bfc-8400-cda4c175199b",
  "32116940-259c-47c7-8298-e06912ea114e",
];

const CANDIDATES = [
  "ValidPass1!",
  "Password1!",
  "password",
  "Password123!",
  "Test1234!",
  "test1234",
  "Test@1234",
  "Test123!",
  "Admin123!",
  "admin123",
  "12345678",
  "password123",
  "Qwerty123!",
  "jk@12345",
  "jk123456",
];

const prisma = new PrismaClient();

async function main() {
  for (const id of HOST_IDS) {
    const u = await prisma.user.findUnique({
      where: { id },
      include: {
        authIdentifiers: { orderBy: [{ isPrimary: "desc" }] },
        authPassword: true,
      },
    });
    if (!u?.authPassword) {
      console.log(`${id}: no password`);
      continue;
    }
    let matched: string | null = null;
    for (const p of CANDIDATES) {
      if (await passwordService.compare(p, u.authPassword.passwordHash)) {
        matched = p;
        break;
      }
    }
    const primary = u.authIdentifiers.find((a) => a.isPrimary) ?? u.authIdentifiers[0];
    console.log(
      `${u.username}: provider=${primary?.provider} id=${primary?.identifier} password=${matched ?? "UNKNOWN (not in candidate list)"}`,
    );
  }
}

main()
  .finally(() => prisma.$disconnect());
