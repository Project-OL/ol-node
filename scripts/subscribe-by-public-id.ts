/**
 * Dev/QA: subscribe one user to a creator by publicId.
 * Usage: npx tsx scripts/subscribe-by-public-id.ts <subscriberUserId> <creatorPublicId>
 */
import "dotenv/config";
import { prisma } from "../src/config/database";
import { subscriptionService } from "../src/services/subscription.service";

async function main() {
  const subscriberId = process.argv[2]?.trim();
  const creatorPublicIdRaw = process.argv[3]?.trim();
  if (!subscriberId || !creatorPublicIdRaw) {
    console.error(
      "Usage: npx tsx scripts/subscribe-by-public-id.ts <subscriberUserId> <creatorPublicId>",
    );
    process.exit(1);
  }

  const creatorPublicId = BigInt(creatorPublicIdRaw);
  const creator = await prisma.user.findFirst({
    where: {
      OR: [
        { publicId: creatorPublicId },
        { defaultPublicId: creatorPublicId },
        { currentVipPublicId: creatorPublicId },
      ],
    },
    select: { id: true, publicId: true, username: true },
  });
  if (!creator) {
    console.error(`Creator not found for publicId ${creatorPublicIdRaw}`);
    process.exit(1);
  }

  const subscriber = await prisma.user.findUnique({
    where: { id: subscriberId },
    select: { id: true, publicId: true, username: true },
  });
  if (!subscriber) {
    console.error(`Subscriber not found: ${subscriberId}`);
    process.exit(1);
  }

  const row = await subscriptionService.createSubscription(subscriberId, creator.id);

  console.log(
    JSON.stringify(
      {
        ok: true,
        subscriber: {
          userId: subscriber.id,
          publicId: subscriber.publicId.toString(),
          username: subscriber.username,
        },
        creator: {
          userId: creator.id,
          publicId: creator.publicId.toString(),
          username: creator.username,
        },
        subscription: {
          id: row.id,
          creatorId: row.creatorId,
          status: row.status,
          nextRenewalAt: row.nextRenewalAt.toISOString(),
        },
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error("\nFailed:", err?.code ?? "", err?.message ?? err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
