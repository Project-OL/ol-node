/**
 * Background job worker (BullMQ). Run as a separate process so API nodes stay stateless.
 * Handles: account deletion (daily at 2 AM UTC).
 *
 * VIP public ID expiry is driven only by Redis TTL on `user:active_vip:{userId}` — no scheduled VIP job.
 */

import "dotenv/config";
import Redis from "ioredis";
import { Queue, Worker, type Job } from "bullmq";
import { env } from "./config/env";
import { prisma } from "./config/database";
import { runAccountDeletionJob } from "./jobs/account-deletion.job";
import { WALLET_WITHDRAWAL_QUEUE } from "./queues/wallet-withdrawal.constants";
import { WALLET_LEVEL_BACKFILL_QUEUE } from "./queues/wallet-level-backfill.constants";
import { runWalletLevelBackfillForUser } from "./jobs/wallet-level-backfill.job";
import {
  SUBSCRIPTION_GRACE_QUEUE,
  SUBSCRIPTION_RENEWAL_QUEUE,
} from "./queues/subscription.constants";
import { subscriptionService } from "./services/subscription.service";
import { GUARDIAN_EXPIRY_QUEUE } from "./queues/guardian.constants";
import { guardianService } from "./services/guardian.service";

const ACCOUNT_DELETION_QUEUE = "account-deletion";

async function main() {
  const connection = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  await connection.connect();

  const accountDeletionQueue = new Queue(ACCOUNT_DELETION_QUEUE, {
    connection,
  });

  await accountDeletionQueue.add(
    "run",
    {},
    {
      jobId: "account-deletion-daily-2am",
      repeat: { pattern: "0 2 * * *" },
      // Retry up to 3 times with exponential backoff (1 min → 2 min → 4 min)
      // so transient DB/network hiccups don't leave accounts stuck in 'deactivating'.
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false, // keep failed jobs for audit
    },
  );

  const accountDeletionWorker = new Worker(
    ACCOUNT_DELETION_QUEUE,
    async (_job: Job) => {
      await runAccountDeletionJob();
    },
    {
      connection,
      concurrency: 3,
    },
  );

  const withdrawalWorker = new Worker(
    WALLET_WITHDRAWAL_QUEUE,
    async (job: Job<{ withdrawalId: string; userId: string }>) => {
      const { withdrawalId, userId } = job.data;
      // Stub: KYC, payout provider, status updates, WITHDRAWAL_REFUND on failure
      console.info("[Wallet Withdrawal] Processing", { withdrawalId, userId });
    },
    { connection, concurrency: 2 },
  );

  const levelBackfillWorker = new Worker(
    WALLET_LEVEL_BACKFILL_QUEUE,
    async (job: Job<{ userId: string }>) => {
      await runWalletLevelBackfillForUser(job.data.userId);
    },
    { connection, concurrency: 2 },
  );

  const subscriptionRenewalWorker = new Worker(
    SUBSCRIPTION_RENEWAL_QUEUE,
    async (job: Job<{ subscriptionId: string }>) => {
      await subscriptionService.processRenewalJob(job.data.subscriptionId);
    },
    { connection, concurrency: 2 },
  );

  const subscriptionGraceWorker = new Worker(
    SUBSCRIPTION_GRACE_QUEUE,
    async (job: Job<{ subscriptionId: string }>) => {
      await subscriptionService.processGraceJob(job.data.subscriptionId);
    },
    { connection, concurrency: 2 },
  );

  const guardianExpiryWorker = new Worker(
    GUARDIAN_EXPIRY_QUEUE,
    async (job: Job<{ guardianId: string }>) => {
      await guardianService.processExpiryJob(job.data.guardianId);
    },
    { connection, concurrency: 2 },
  );

  accountDeletionWorker.on("failed", (job, err) => {
    console.error("[Account Deletion] Job failed:", job?.id, err);
  });

  withdrawalWorker.on("failed", (job, err) => {
    console.error("[Wallet Withdrawal] Job failed:", job?.id, err);
  });

  levelBackfillWorker.on("failed", (job, err) => {
    console.error("[Wallet Level Backfill] Job failed:", job?.id, err);
  });

  subscriptionRenewalWorker.on("failed", (job, err) => {
    console.error("[Subscription renewal] Job failed:", job?.id, err);
  });

  subscriptionGraceWorker.on("failed", (job, err) => {
    console.error("[Subscription grace] Job failed:", job?.id, err);
  });

  guardianExpiryWorker.on("failed", (job, err) => {
    console.error("[Guardian expiry] Job failed:", job?.id, err);
  });

  console.info(
    "Worker started: account-deletion; wallet-withdrawals; wallet-level-backfill; subscription-renewal; subscription-grace; guardian-expiry; VIP expiry is Redis TTL only",
  );

  const shutdown = async () => {
    await guardianExpiryWorker.close();
    await subscriptionGraceWorker.close();
    await subscriptionRenewalWorker.close();
    await levelBackfillWorker.close();
    await withdrawalWorker.close();
    await accountDeletionWorker.close();
    await accountDeletionQueue.close();
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
