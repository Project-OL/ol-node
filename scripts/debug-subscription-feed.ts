import "dotenv/config";
import { prisma } from "../src/config/database";
import { subscriptionRepository } from "../src/repositories/subscription.repository";
import { postRepository } from "../src/repositories/post.repository";

const SUBSCRIBER_ID = "fbc0640d-05b0-4df9-a9bb-266eb5a0484b";

async function main() {
  const subs = await subscriptionRepository.getActiveSubscriptions(SUBSCRIBER_ID);
  console.log("ACTIVE subscriptions:", subs.length);
  for (const s of subs) {
    const creator = await prisma.user.findUnique({
      where: { id: s.creatorId },
      select: { publicId: true, username: true },
    });
    const postCount = await prisma.post.count({ where: { userId: s.creatorId } });
    const posts = await prisma.post.findMany({
      where: { userId: s.creatorId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, createdAt: true, subscriberOnly: true, caption: true },
    });
    console.log("\n---");
    console.log("creatorId:", s.creatorId);
    console.log("publicId:", creator?.publicId?.toString());
    console.log("username:", creator?.username);
    console.log("postCount:", postCount);
    console.log("recent posts:", posts);

    const feedRows = await postRepository.getSubscriptionFeed([s.creatorId], 20);
    console.log("feed query rows for this creator:", feedRows.length);
  }

  const allCreatorIds = subs.map((s) => s.creatorId);
  const feedAll = await postRepository.getSubscriptionFeed(allCreatorIds, 20);
  console.log("\n=== combined feed (limit 20) ===", feedAll.length);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
