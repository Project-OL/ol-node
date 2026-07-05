import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  PLATFORM_LEDGER_MESSAGE_JOB,
  PLATFORM_MESSAGE_QUEUE,
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
  await platformMessageQueue.add(PLATFORM_NOTIFICATION_BROADCAST_JOB, data, jobOpts)
}
