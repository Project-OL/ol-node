import { Queue } from 'bullmq'
import { randomUUID } from 'crypto'
import { redisClient } from '../config/redis'
import {
  PUSH_BROADCAST_BATCH_JOB,
  PUSH_BROADCAST_JOB,
  PUSH_BROADCAST_SWEEP_JOB,
  PUSH_NOTIFICATION_QUEUE,
} from './push-notification.constants'

const jobOpts = {
  attempts: 6,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: 2000,
  removeOnFail: 500,
}

export const pushNotificationQueue = new Queue(PUSH_NOTIFICATION_QUEUE, {
  connection: redisClient,
})

export async function enqueuePushBroadcast(data: {
  adminUserId: string
  title: string
  body: string
  data?: Record<string, string>
  userIds?: string[]
  country?: string
  campaignId?: string
}): Promise<string> {
  // Mint the effective campaignId at enqueue time — per-recipient batching keys derive
  // from it, so it must be stable across BullMQ retries of the planner job.
  const campaignId = data.campaignId ?? `push-broadcast:${randomUUID()}`
  await pushNotificationQueue.add(PUSH_BROADCAST_JOB, { ...data, campaignId }, jobOpts)
  return campaignId
}

export function pushBroadcastBatchJobId(campaignId: string, batchIndex: number): string {
  return `push-notify-batch:${campaignId}:${batchIndex}`
}

export async function enqueuePushBroadcastBatch(data: {
  campaignId: string
  batchIndex: number
  title: string
  body: string
  data?: Record<string, string>
  adminUserId?: string
  recipients: Array<{ userId: string; token: string }>
}): Promise<void> {
  await pushNotificationQueue.add(PUSH_BROADCAST_BATCH_JOB, data, {
    ...jobOpts,
    jobId: pushBroadcastBatchJobId(data.campaignId, data.batchIndex),
    priority: 10,
  })
}

/** Called from `worker.ts` once — 60s sweep re-enqueuing stale push-broadcast batches (crash recovery). */
export async function registerPushBroadcastSweep(): Promise<void> {
  await pushNotificationQueue.add(
    PUSH_BROADCAST_SWEEP_JOB,
    {},
    {
      repeat: { every: 60_000 },
      jobId: 'push-broadcast-sweep-repeat',
      attempts: 1,
      removeOnComplete: 100,
    },
  )
}
