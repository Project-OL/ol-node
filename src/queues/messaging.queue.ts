import { Queue } from 'bullmq';
import { redisClient } from '../config/redis';
import {
  MESSAGE_OUTBOX_PUBLISH_JOB,
  MESSAGE_OUTBOX_QUEUE,
  MESSAGE_OUTBOX_SWEEP_JOB,
} from './messaging.constants';

const jobOpts = {
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 500 },
  removeOnComplete: 2000,
  removeOnFail: 500,
};

export const messageOutboxQueue = new Queue(MESSAGE_OUTBOX_QUEUE, {
  connection: redisClient,
});

/** Fire-and-forget after `sendMessage` commits (single row per send). */
export async function enqueueMessageOutboxPublish(outboxId: bigint): Promise<void> {
  await messageOutboxQueue.add(MESSAGE_OUTBOX_PUBLISH_JOB, {
    outboxId: outboxId.toString(),
  }, jobOpts);
}

/** Called from `worker.ts` once — 5s stale-outbox sweep (crash recovery). */
export async function registerMessageOutboxScheduledJobs(): Promise<void> {
  await messageOutboxQueue.add(
    MESSAGE_OUTBOX_SWEEP_JOB,
    {},
    {
      repeat: { every: 5000 },
      jobId: 'message-outbox-sweep-repeat',
      attempts: 1,
      removeOnComplete: 100,
    },
  );
}
