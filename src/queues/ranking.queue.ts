import { Queue } from 'bullmq'
import { redisClient } from '../config/redis'
import { RANKING_BACKFILL_JOB, RANKING_BACKFILL_QUEUE, RANKING_RECONCILE_JOB } from './ranking.constants'

export const rankingBackfillQueue = new Queue(RANKING_BACKFILL_QUEUE, {
  connection: redisClient,
})

export async function enqueueRankingBackfill90d(): Promise<void> {
  await rankingBackfillQueue.add(
    RANKING_BACKFILL_JOB,
    {},
    {
      jobId: `ranking-backfill-90d-${new Date().toISOString().slice(0, 10)}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  )
}

export async function registerRankingReconcileJob(): Promise<void> {
  await rankingBackfillQueue.add(
    RANKING_RECONCILE_JOB,
    {},
    {
      jobId: 'ranking-reconcile-daily-4am-utc',
      repeat: { pattern: '0 4 * * *', tz: 'UTC' },
      attempts: 2,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 20,
      removeOnFail: 50,
    },
  )
}
