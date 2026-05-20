/**
 * Dev helper: lookup user(s) by email substring and optionally set login password.
 * Usage:
 *   npx tsx scripts/lookup-user-by-email.ts offooliveinfo
 *   npx tsx scripts/lookup-user-by-email.ts offooliveinfo --set-password "ValidPass1!"
 */
import { PrismaClient } from "@prisma/client";
import { passwordService } from "../src/services/password.service";

const prisma = new PrismaClient();

async function applyDevPassword(userId: string, label: string, newPassword: string) {
  await passwordService.setPassword(userId, newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordSet: true } });
  console.log(`\nSet login password for ${label}`);
  console.log(`  password: ${newPassword}`);
  console.log(`  login: POST /api/v1/auth/login/password with provider "publicId" and identifier "<publicId>"`);
}

async function main() {
  const args = process.argv.slice(2);
  const emailPart = args.find((a) => !a.startsWith("--"));
  const setPasswordIdx = args.indexOf("--set-password");
  const newPassword =
    setPasswordIdx >= 0 ? args[setPasswordIdx + 1] : undefined;

  if (!emailPart) {
    console.error("Usage: tsx scripts/lookup-user-by-email.ts <email-part> [--set-password <pwd>]");
    process.exit(1);
  }

  const rows = await prisma.authIdentifier.findMany({
    where: {
      identifier: { contains: emailPart, mode: "insensitive" },
    },
    select: {
      identifier: true,
      isPrimary: true,
      user: {
        select: {
          id: true,
          username: true,
          publicId: true,
          passwordSet: true,
          isAgent: true,
          authPassword: { select: { id: true } },
        },
      },
    },
  });

  if (rows.length === 0) {
    const byUsername = await prisma.user.findMany({
      where: { username: { contains: emailPart, mode: "insensitive" } },
      select: {
        id: true,
        username: true,
        publicId: true,
        passwordSet: true,
        isAgent: true,
        authPassword: { select: { id: true } },
        authIdentifiers: { select: { provider: true, identifier: true, isPrimary: true } },
      },
      take: 10,
    });
    if (byUsername.length > 0) {
      console.log(`No auth identifier match; ${byUsername.length} user(s) by username:`);
      for (const u of byUsername) {
        console.log("\n---");
        console.log(`username: ${u.username}`);
        console.log(`userId: ${u.id}`);
        console.log(`publicId: ${u.publicId}`);
        console.log(`passwordSet: ${u.passwordSet}`);
        for (const ai of u.authIdentifiers) {
          console.log(`  ${ai.provider}: ${ai.identifier}${ai.isPrimary ? " (primary)" : ""}`);
        }
      }
      if (newPassword) {
        if (byUsername.length > 1) {
          console.error("\nRefusing --set-password: multiple users matched.");
          process.exit(1);
        }
        const u = byUsername[0]!;
        await applyDevPassword(u.id, u.username, newPassword);
      }
      return;
    }
    console.log(`No user/identifier containing "${emailPart}" in this database`);
    return;
  }

  for (const r of rows) {
    const u = r.user;
    console.log("\n---");
    console.log(`email: ${r.identifier}${r.isPrimary ? " (primary)" : ""}`);
    console.log(`userId: ${u.id}`);
    console.log(`username: ${u.username}`);
    console.log(`publicId: ${u.publicId}`);
    console.log(`isAgent: ${u.isAgent}`);
    console.log(`passwordSet: ${u.passwordSet}`);
    console.log(`hasAuthPassword: ${u.authPassword != null}`);
    console.log("(plaintext password cannot be recovered — only bcrypt hash in DB)");
  }

  if (newPassword) {
    if (rows.length > 1) {
      console.error("\nRefusing --set-password: multiple users matched. Narrow the email part.");
      process.exit(1);
    }
    const u = rows[0]!.user;
    await applyDevPassword(u.id, rows[0]!.identifier, newPassword);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
