/**
 * Background job worker (BullMQ). Run as a separate process so API nodes stay stateless.
 * Handles: account deletion (daily at 2 AM UTC).
 *
 * VIP public ID expiry is driven only by Redis TTL on `user:active_vip:{userId}` — no scheduled VIP job.
 */

import 'dotenv/config'
import Redis from 'ioredis'
import { Queue, Worker, type Job } from 'bullmq'
import { env } from './config/env'
import { prisma } from './config/database'
import { runAccountDeletionJob } from './jobs/account-deletion.job'

const ACCOUNT_DELETION_QUEUE = 'account-deletion'

async function main() {
  const connection = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
  await connection.connect()

  const accountDeletionQueue = new Queue(ACCOUNT_DELETION_QUEUE, { connection })

  await accountDeletionQueue.add(
    'run',
    {},
    {
      jobId: 'account-deletion-daily-2am',
      repeat: { pattern: '0 2 * * *' },
    },
  )

  const accountDeletionWorker = new Worker(
    ACCOUNT_DELETION_QUEUE,
    async (_job: Job) => {
      await runAccountDeletionJob()
    },
    {
      connection,
      concurrency: 3,
    },
  )

  accountDeletionWorker.on('failed', (job, err) => {
    console.error('[Account Deletion] Job failed:', job?.id, err)
  })

  console.info('Worker started: account-deletion (daily 2 AM UTC); VIP expiry is Redis TTL only')

  const shutdown = async () => {
    await accountDeletionWorker.close()
    await accountDeletionQueue.close()
    await prisma.$disconnect()
    await connection.quit()
    process.exit(0)
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((err) => {
  console.error('Worker failed to start:', err)
  process.exit(1)
})
