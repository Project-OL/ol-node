/**
 * One-time: enqueue wallet level backfill for every user (worker must be running).
 * Run: npx tsx scripts/enqueue-level-backfill.ts
 */
import "dotenv/config";
import { Queue } from "bullmq";
import { prisma } from "../src/config/database";
import { redisClient } from "../src/config/redis";
import { WALLET_LEVEL_BACKFILL_QUEUE } from "../src/queues/wallet-level-backfill.constants";

async function main() {
  const queue = new Queue(WALLET_LEVEL_BACKFILL_QUEUE, {
    connection: redisClient,
  });
  const users = await prisma.user.findMany({ select: { id: true } });
  for (const u of users) {
    await queue.add("backfill", { userId: u.id }, { attempts: 3 });
  }
  console.info(`Enqueued ${users.length} users for ${WALLET_LEVEL_BACKFILL_QUEUE}`);
  await queue.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
