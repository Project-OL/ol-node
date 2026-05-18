import { PrismaClient } from "@prisma/client";
import { passwordService } from "../src/services/password.service";

const DEV_PASSWORD = "ValidPass1!";
const HOST_IDS = [
  "0b091517-3365-4c9e-ae2a-0a02f0425f66",
  "3d18e6be-4e56-4dbe-97bd-c6bf25b4dde8",
  "1e7d864a-6730-4562-8563-8c0a2aece85b",
  "2fc988aa-2ed5-4bfc-8400-cda4c175199b",
  "32116940-259c-47c7-8298-e06912ea114e",
];

const prisma = new PrismaClient();

async function main() {
  for (const id of HOST_IDS) {
    await passwordService.setPassword(id, DEV_PASSWORD);
    await prisma.user.update({
      where: { id },
      data: { passwordSet: true },
    });
    console.log(`Set password for ${id}`);
  }
}

main()
  .finally(() => prisma.$disconnect());
