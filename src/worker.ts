/**
 * Background job worker (BullMQ). Run as a separate process so API nodes stay stateless.
 * Handles: account deletion (daily at 2 AM UTC).
 *
 * VIP **public ID** expiry is driven by Redis TTL on `user:active_vip:{userId}`. **Paid** Diamond/SVIP membership uses BullMQ `vip-membership-expiry`.
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
import {
  RARE_ID_EXPIRY_JOB,
  STORE_ITEM_EXPIRY_JOB,
  STORE_ITEM_EXPIRY_QUEUE,
} from "./queues/store-item-expiry.constants";
import { storeService } from "./services/store.service";
import {
  PUBLIC_ID_PREGEN_HORIZON_JOB,
  PUBLIC_ID_PREGEN_QUEUE,
} from "./queues/public-id-pregen.constants";
import { publicIdPreGenerationService } from "./services/public-id-pre-generation.service";
import {
  RICH_TIER_JOB_MASTER,
  RICH_TIER_ROLLOVER_QUEUE,
} from "./queues/rich-tier.constants";
import { processRichTierRolloverJob } from "./jobs/rich-tier-rollover.job";
import {
  VIP_MEMBERSHIP_EXPIRY_JOB,
  VIP_MEMBERSHIP_EXPIRY_QUEUE,
} from "./queues/vip-membership.constants";
import { processVipMembershipExpiryJob } from "./jobs/vip-membership-expiry.job";
import {
  AGENCY_LEAVE_AUTO_APPROVE_QUEUE,
  AGENCY_LEAVE_SAFETY_NET_JOB,
} from "./queues/agency.constants";
import { agencyLeaveAutoApproveQueue } from "./queues/agency.queue";
import { processAgencyLeaveWorkerJob } from "./jobs/agency-leave-auto-approve.job";
import {
  AGENCY_LEVEL_JOB_MASTER,
  AGENCY_LEVEL_RECOMPUTE_QUEUE,
} from "./queues/agency-commission.constants";
import { agencyLevelRecomputeQueue } from "./queues/agency-commission.queue";
import { processAgencyLevelRecomputeJob } from "./jobs/agency-level-recompute.job";
import {
  MESSAGE_OUTBOX_PUBLISH_JOB,
  MESSAGE_OUTBOX_QUEUE,
  MESSAGE_OUTBOX_SWEEP_JOB,
} from "./queues/messaging.constants";
import {
  messageOutboxQueue,
  registerMessageOutboxScheduledJobs,
} from "./queues/messaging.queue";
import {
  MESSAGE_MEDIA_AUDIO_PROCESS_JOB,
  MESSAGE_MEDIA_AUDIO_QUEUE,
} from "./queues/message-media-audio.constants";
import { messageMediaAudioQueue } from "./queues/message-media-audio.queue";
import { processMessageMediaAudioJob } from "./jobs/message-media-audio-processing.job";
import {
  publishMessageOutboxRow,
  sweepStaleMessageOutbox,
} from "./services/messaging-outbox.service";
import { ensureCollectionExists } from "./lib/rekognition.client";
import { EPAY_WEBHOOK_RETRY_JOB, EPAY_WEBHOOK_RETRY_QUEUE } from "./queues/epay-webhook.constants";
import { coinWalletService } from "./services/coin-wallet.service";
import { coinTradingService } from "./services/coinTrading.service";
import {
  PAYROLL_SLA_JOB,
  PAYROLL_SLA_QUEUE,
  PAYROLL_SAFETY_NET_JOB,
} from "./queues/payroll.constants";
import { payrollSlaQueue } from "./queues/payroll.queue";
import {
  processPayrollSlaJob,
  runPayrollSlaSafetyNet,
} from "./jobs/payroll-sla.job";

const ACCOUNT_DELETION_QUEUE = "account-deletion";

async function main() {
  try {
    await ensureCollectionExists();
  } catch (error) {
    console.error("Failed to ensure Rekognition collection exists", error);
    process.exit(1);
  }

  const connection = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  await connection.connect();

  await registerMessageOutboxScheduledJobs();

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

  const storeItemExpiryWorker = new Worker(
    STORE_ITEM_EXPIRY_QUEUE,
    async (job: Job<{ userStoreItemId?: string; assignmentId?: string }>) => {
      if (job.name === STORE_ITEM_EXPIRY_JOB) {
        await storeService.processExpiryJob(job.data.userStoreItemId!);
      } else if (job.name === RARE_ID_EXPIRY_JOB) {
        await storeService.processRareIdExpiryJob(job.data.assignmentId!);
      }
    },
    { connection, concurrency: 2 },
  );

  const publicIdPregenWorker = new Worker(
    PUBLIC_ID_PREGEN_QUEUE,
    async (job: Job) => {
      if (job.name === PUBLIC_ID_PREGEN_HORIZON_JOB) {
        await publicIdPreGenerationService.runHorizonJob();
      }
    },
    { connection, concurrency: 1 },
  );

  const richTierRolloverQueue = new Queue(RICH_TIER_ROLLOVER_QUEUE, {
    connection,
  });

  await richTierRolloverQueue.add(
    RICH_TIER_JOB_MASTER,
    {},
    {
      repeat: { pattern: "5 0 1 * *", tz: "UTC" },
      jobId: "rich-tier-repeatable-master-utc",
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  );

  const richTierRolloverWorker = new Worker(
    RICH_TIER_ROLLOVER_QUEUE,
    async (job: Job) => {
      await processRichTierRolloverJob(job);
    },
    { connection, concurrency: 2 },
  );

  const vipMembershipExpiryWorker = new Worker(
    VIP_MEMBERSHIP_EXPIRY_QUEUE,
    async (job: Job<{ userId: string }>) => {
      if (job.name === VIP_MEMBERSHIP_EXPIRY_JOB) {
        await processVipMembershipExpiryJob(job);
      }
    },
    { connection, concurrency: 2 },
  );

  await agencyLeaveAutoApproveQueue.add(
    AGENCY_LEAVE_SAFETY_NET_JOB,
    {},
    {
      repeat: { pattern: "0 * * * *", tz: "UTC" },
      jobId: "agency-leave-safety-net-hourly-utc",
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  );

  const agencyLeaveWorker = new Worker(
    AGENCY_LEAVE_AUTO_APPROVE_QUEUE,
    async (job: Job<{ applicationId?: string }>) => {
      await processAgencyLeaveWorkerJob(job);
    },
    { connection, concurrency: 2 },
  );

  await agencyLevelRecomputeQueue.add(
    AGENCY_LEVEL_JOB_MASTER,
    {},
    {
      repeat: { pattern: "5 0 * * *", tz: "UTC" },
      jobId: "agency-level-recompute-repeatable-master-utc",
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  );

  const agencyLevelRecomputeWorker = new Worker(
    AGENCY_LEVEL_RECOMPUTE_QUEUE,
    async (job: Job) => {
      await processAgencyLevelRecomputeJob(job);
    },
    { connection, concurrency: 2 },
  );

  const messageOutboxWorker = new Worker(
    MESSAGE_OUTBOX_QUEUE,
    async (job: Job<{ outboxId?: string }>) => {
      if (job.name === MESSAGE_OUTBOX_PUBLISH_JOB) {
        const id = job.data?.outboxId;
        if (id) await publishMessageOutboxRow(BigInt(id));
      } else if (job.name === MESSAGE_OUTBOX_SWEEP_JOB) {
        await sweepStaleMessageOutbox();
      }
    },
    { connection, concurrency: 8 },
  );

  const messageMediaAudioWorker = new Worker(
    MESSAGE_MEDIA_AUDIO_QUEUE,
    async (job: Job<{ messageMediaId?: string }>) => {
      if (job.name === MESSAGE_MEDIA_AUDIO_PROCESS_JOB && job.data?.messageMediaId) {
        await processMessageMediaAudioJob(job.data.messageMediaId);
      }
    },
    { connection, concurrency: 4 },
  );

  await payrollSlaQueue.add(
    PAYROLL_SAFETY_NET_JOB,
    {},
    {
      repeat: { pattern: "10 * * * *", tz: "UTC" },
      jobId: "payroll-sla-safety-net-hourly-utc",
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
    },
  );

  const payrollSlaWorker = new Worker(
    PAYROLL_SLA_QUEUE,
    async (job: Job<{ assignmentId?: string }>) => {
      if (job.name === PAYROLL_SLA_JOB) {
        const id = job.data?.assignmentId;
        if (id) await processPayrollSlaJob({ assignmentId: id });
      } else if (job.name === PAYROLL_SAFETY_NET_JOB) {
        await runPayrollSlaSafetyNet();
      }
    },
    { connection, concurrency: 2 },
  );

  const epayWebhookRetryWorker = new Worker(
    EPAY_WEBHOOK_RETRY_QUEUE,
    async (job: Job<{ payload: any; orderType: "PERSONAL_TOPUP" | "TRADING_TOPUP" }>) => {
      if (job.name !== EPAY_WEBHOOK_RETRY_JOB) return;
      const payload = job.data.payload;
      if (job.data.orderType === "PERSONAL_TOPUP") {
        await coinWalletService.confirmTopup(
          payload.userId,
          payload.orderId,
          payload.gatewayRef,
          `epay-personal-topup:${payload.orderId}`,
        );
      } else {
        const order = await prisma.coinTradingTopupOrder.findUnique({ where: { id: payload.orderId } });
        if (order) await coinTradingService.confirmTopup(order, payload);
      }
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

  storeItemExpiryWorker.on("failed", (job, err) => {
    console.error("[Store item expiry] Job failed:", job?.id, err);
  });

  publicIdPregenWorker.on("failed", (job, err) => {
    console.error("[Public ID pregen] Job failed:", job?.id, err);
  });

  richTierRolloverWorker.on("failed", (job, err) => {
    console.error("[Rich tier rollover] Job failed:", job?.id, err);
  });

  vipMembershipExpiryWorker.on("failed", (job, err) => {
    console.error("[VIP membership expiry] Job failed:", job?.id, err);
  });

  agencyLeaveWorker.on("failed", (job, err) => {
    console.error("[Agency leave auto-approve] Job failed:", job?.id, err);
  });

  agencyLevelRecomputeWorker.on("failed", (job, err) => {
    console.error("[Agency level recompute] Job failed:", job?.id, err);
  });

  messageOutboxWorker.on("failed", (job, err) => {
    console.error("[Message outbox] Job failed:", job?.id, err);
  });

  messageMediaAudioWorker.on("failed", (job, err) => {
    console.error("[Message media audio] Job failed:", job?.id, err);
  });
  epayWebhookRetryWorker.on("failed", (job, err) => {
    console.error("[Epay webhook retry] Job failed:", job?.id, err);
  });

  payrollSlaWorker.on("failed", (job, err) => {
    console.error("[Payroll SLA] Job failed:", job?.id, err);
  });

  console.info(
    "Worker started: account-deletion; wallet-withdrawals; wallet-level-backfill; subscription-renewal; subscription-grace; guardian-expiry; store-item-expiry (incl. rare-id); public-id-pregen; rich-tier-rollover; vip-membership-expiry; agency-level-recompute; agency-leave-auto-approve; payroll-sla; message-outbox; message-media-audio; epay-webhook-retry (face indexing: run `npm run worker:face-index` — Postgres poll, no Redis queue)",
  );

  const shutdown = async () => {
    await payrollSlaWorker.close();
    await payrollSlaQueue.close();
    await epayWebhookRetryWorker.close();
    await messageMediaAudioWorker.close();
    await messageMediaAudioQueue.close();
    await messageOutboxWorker.close();
    await messageOutboxQueue.close();
    await agencyLevelRecomputeWorker.close();
    await agencyLevelRecomputeQueue.close();
    await agencyLeaveWorker.close();
    await agencyLeaveAutoApproveQueue.close();
    await vipMembershipExpiryWorker.close();
    await richTierRolloverWorker.close();
    await richTierRolloverQueue.close();
    await publicIdPregenWorker.close();
    await storeItemExpiryWorker.close();
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
