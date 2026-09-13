import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { utcDateString } from '../utils/datetime'
import {
  ROYAL_HOST_JOB_BATCH,
  ROYAL_HOST_JOB_MASTER,
  ROYAL_HOST_EVAL_QUEUE,
} from './royalHost.constants'

const royalHostJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 500,
}

export const royalHostEvalQueue = new Queue(ROYAL_HOST_EVAL_QUEUE, {
  connection: redisClient,
})

export async function enqueueEvalMaster(weekStart: Date, force?: boolean): Promise<void> {
  const weekStartStr = utcDateString(weekStart)
  await royalHostEvalQueue.add(
    ROYAL_HOST_JOB_MASTER,
    { weekStart: weekStartStr, force },
    {
      ...royalHostJobOptions,
      jobId: `master:${weekStartStr}${force ? ':force' : ''}`,
    },
  )
}

export async function enqueueEvalBatch(weekStart: Date, userIds: string[]): Promise<void> {
  const weekStartStr = utcDateString(weekStart)
  const start = userIds[0] ?? ''
  const end = userIds[userIds.length - 1] ?? ''
  await royalHostEvalQueue.add(
    ROYAL_HOST_JOB_BATCH,
    { weekStart: weekStartStr, userIds },
    {
      ...royalHostJobOptions,
      jobId: `batch:${weekStartStr}:${start}-${end}`,
    },
  )
}
