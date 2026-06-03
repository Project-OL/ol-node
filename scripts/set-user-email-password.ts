/**
 * Dev/QA: bind email + set login password on an existing user (e.g. Google-only account).
 *
 * Usage:
 *   npx tsx scripts/set-user-email-password.ts <userId> <email> [password]
 *   npx tsx scripts/set-user-email-password.ts --google-sub <googleSub> <email> [password]
 *
 * Default password: ValidPass1!
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { authIdentifierRepository } from "../src/repositories/auth-identifier.repository";
import { passwordService } from "../src/services/password.service";
import { cacheService } from "../src/services/cache.service";

const DEFAULT_PASSWORD = "ValidPass1!";

async function resolveUserId(arg: string, googleSub?: string): Promise<string> {
  if (googleSub) {
    const row = await authIdentifierRepository.findByProviderAndIdentifier(
      "google",
      googleSub,
    );
    if (!row) {
      throw new Error(`No user with google identifier ${googleSub}`);
    }
    return row.userId;
  }
  const user = await prisma.user.findUnique({
    where: { id: arg },
    select: { id: true },
  });
  if (!user) throw new Error(`User not found: ${arg}`);
  return user.id;
}

async function main() {
  let userId: string;
  let email: string;
  let password = DEFAULT_PASSWORD;

  const args = process.argv.slice(2);
  if (args[0] === "--google-sub") {
    const googleSub = args[1]?.trim();
    email = args[2]?.trim().toLowerCase() ?? "";
    password = args[3] ?? DEFAULT_PASSWORD;
    if (!googleSub || !email) {
      console.error(
        "Usage: npx tsx scripts/set-user-email-password.ts --google-sub <googleSub> <email> [password]",
      );
      process.exit(1);
    }
    userId = await resolveUserId("", googleSub);
  } else {
    userId = await resolveUserId(args[0]?.trim() ?? "");
    email = args[1]?.trim().toLowerCase() ?? "";
    password = args[2] ?? DEFAULT_PASSWORD;
    if (!args[0] || !email) {
      console.error(
        "Usage: npx tsx scripts/set-user-email-password.ts <userId> <email> [password]",
      );
      process.exit(1);
    }
  }

  const strength = passwordService.validateStrength(password);
  if (!strength.ok) {
    console.error(`Weak password: ${strength.error}`);
    process.exit(1);
  }

  const emailTaken = await authIdentifierRepository.findByProviderAndIdentifier(
    "email",
    email,
  );
  if (emailTaken && emailTaken.userId !== userId) {
    console.error(`Email ${email} is already linked to user ${emailTaken.userId}`);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, publicId: true, passwordSet: true },
  });
  if (!user) {
    console.error(`User not found: ${userId}`);
    process.exit(1);
  }

  const existingEmail = await authIdentifierRepository.findByUserId(userId);
  const hasEmail = existingEmail.some((a) => a.provider === "email");

  await prisma.$transaction(async (tx) => {
    if (!hasEmail) {
      await tx.authIdentifier.create({
        data: {
          userId,
          provider: "email",
          identifier: email,
          isVerified: true,
          verifiedAt: new Date(),
          isPrimary: false,
        },
      });
    } else {
      const row = existingEmail.find((a) => a.provider === "email")!;
      if (row.identifier !== email) {
        await tx.authIdentifier.update({
          where: { id: row.id },
          data: {
            identifier: email,
            isVerified: true,
            verifiedAt: new Date(),
          },
        });
      }
    }

    const hasPwd = await passwordService.hasPassword(userId);
    if (hasPwd) {
      await passwordService.setPassword(userId, password);
    } else {
      await passwordService.createPassword(userId, password);
    }

    await tx.user.update({
      where: { id: userId },
      data: { passwordSet: true },
    });
  });

  await cacheService.invalidateUserAuthIdentifiers(userId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        userId,
        username: user.username,
        publicId: user.publicId.toString(),
        email,
        password,
        loginHint:
          "POST /api/v1/auth/check-availability { provider: email, identifier } then POST /api/v1/auth/login/password",
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
