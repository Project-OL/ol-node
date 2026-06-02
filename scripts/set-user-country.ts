/**
 * Dev/QA: set a user's country.
 * Usage: npx tsx scripts/set-user-country.ts <userId> <country>
 */
import "dotenv/config";
import { prisma } from "../src/config/database";

async function main() {
  const userId = process.argv[2]?.trim();
  const country = process.argv[3]?.trim() ?? "India";
  if (!userId) {
    console.error("Usage: npx tsx scripts/set-user-country.ts <userId> [country]");
    process.exit(1);
  }

  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, publicId: true, country: true, username: true },
  });
  if (!before) {
    console.error(`User not found: ${userId}`);
    process.exit(1);
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { country },
  });

  console.log(
    JSON.stringify(
      {
        before: {
          userId: before.id,
          publicId: before.publicId.toString(),
          username: before.username,
          country: before.country,
        },
        after: {
          userId: updated.id,
          publicId: updated.publicId.toString(),
          country: updated.country,
        },
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
