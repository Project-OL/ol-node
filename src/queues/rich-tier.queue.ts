import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import {
  RICH_TIER_JOB_BATCH,
  RICH_TIER_JOB_MASTER,
  RICH_TIER_ROLLOVER_QUEUE,
} from './rich-tier.constants'

const richTierJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 500,
}

export const richTierRolloverQueue = new Queue(RICH_TIER_ROLLOVER_QUEUE, {
  connection: redisClient,
})

export async function enqueueRolloverMaster(
  year: number,
  month: number,
  force?: boolean,
): Promise<void> {
  await richTierRolloverQueue.add(
    RICH_TIER_JOB_MASTER,
    { year, month, force },
    {
      ...richTierJobOptions,
      jobId: `master:${year}-${month}${force ? ':force' : ''}`,
    },
  )
}

export async function enqueueRolloverBatch(
  year: number,
  month: number,
  userIds: string[],
): Promise<void> {
  const start = userIds[0] ?? ''
  const end = userIds[userIds.length - 1] ?? ''
  await richTierRolloverQueue.add(
    RICH_TIER_JOB_BATCH,
    { year, month, userIds },
    {
      ...richTierJobOptions,
      jobId: `batch:${year}-${month}:${start}-${end}`,
    },
  )
}
