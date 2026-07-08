import { Queue } from 'bullmq'
import { randomUUID } from 'crypto'
import { redisClient } from '../config/redis'
import {
  PLATFORM_BROADCAST_SWEEP_JOB,
  PLATFORM_LEDGER_MESSAGE_JOB,
  PLATFORM_MESSAGE_QUEUE,
  PLATFORM_NOTIFICATION_BROADCAST_BATCH_JOB,
  PLATFORM_NOTIFICATION_BROADCAST_JOB,
  PLATFORM_WITHDRAWAL_MESSAGE_JOB,
} from './platform-message.constants'

const jobOpts = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: 2000,
  removeOnFail: 500,
}

export const platformMessageQueue = new Queue(PLATFORM_MESSAGE_QUEUE, {
  connection: redisClient,
})

/** Delayed so the enclosing wallet transaction has committed before the worker reads the ledger row. */
export async function enqueuePlatformLedgerMessage(
  kind: 'coin' | 'point',
  entryId: string,
): Promise<void> {
  await platformMessageQueue.add(
    PLATFORM_LEDGER_MESSAGE_JOB,
    { kind, entryId },
    { ...jobOpts, delay: 750 },
  )
}

export async function enqueuePlatformWithdrawalMessage(data: {
  withdrawalId: string
  event: string
  hostUserId: string
  agentUserId?: string
  reason?: string
}): Promise<void> {
  await platformMessageQueue.add(PLATFORM_WITHDRAWAL_MESSAGE_JOB, data, jobOpts)
}

export async function enqueuePlatformNotificationBroadcast(data: {
  adminUserId: string
  message: string
  userIds?: string[]
  campaignId?: string
}): Promise<void> {
  // Mint the effective campaignId at enqueue time: per-recipient clientMessageIds
  // (`notify:{campaignId}:{userId}`) derive from it, so it must be stable across
  // BullMQ retries of the job or every retry would re-send the whole broadcast.
  const campaignId = data.campaignId ?? `broadcast:${randomUUID()}`
  await platformMessageQueue.add(
    PLATFORM_NOTIFICATION_BROADCAST_JOB,
    { ...data, campaignId },
    jobOpts,
  )
}

export function broadcastBatchJobId(campaignId: string, batchIndex: number): string {
  return `notify-batch:${campaignId}:${batchIndex}`
}

/**
 * One batch of a notification broadcast. Deterministic jobId dedupes re-enqueues
 * (parent retry, sweep); `priority` keeps transactional platform messages (no
 * priority = always first in BullMQ) from queueing behind a large broadcast.
 */
export async function enqueuePlatformNotificationBroadcastBatch(data: {
  campaignId: string
  batchIndex: number
  adminUserId: string
  message: string
  userIds: string[]
}): Promise<void> {
  await platformMessageQueue.add(PLATFORM_NOTIFICATION_BROADCAST_BATCH_JOB, data, {
    ...jobOpts,
    jobId: broadcastBatchJobId(data.campaignId, data.batchIndex),
    priority: 10,
  })
}

/** Called from `worker.ts` once — 60s sweep re-enqueuing stale broadcast batches (crash recovery). */
export async function registerPlatformBroadcastSweep(): Promise<void> {
  await platformMessageQueue.add(
    PLATFORM_BROADCAST_SWEEP_JOB,
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'platform-broadcast-sweep-repeat',
      attempts: 1,
      removeOnComplete: 100,
    },
  )
}
