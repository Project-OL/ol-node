/**
 * Face + Rekognition worker process:
 * - Postgres poll: `user_face_profiles` in `PENDING_INDEX` → Rekognition `IndexFaces` / duplicate handling.
 * - BullMQ: `live-photo-verify` (CompareFaces + S3 purge jobs) and `face-registration` (Face Liveness results → reference image → `PENDING_INDEX`).
 *
 * Requires the same `REDIS_URL` as the API for BullMQ. Run `npm run worker` for all other queues only.
 */
import 'dotenv/config'
import { setTimeout as sleep } from 'node:timers/promises'
import Redis from 'ioredis'
import { Worker, type Job } from 'bullmq'
import { env } from './config/env'
import { prisma, prismaRead } from './config/database'
import { redisReadClient } from './config/redis'
import { registerCrashHandlers } from './utils/crashHandlers'
import { withShutdownTimeout } from './utils/shutdownTimeout'
import { ensureCollectionExists } from './lib/rekognition.client'
import { runFaceIndexPollOnce } from './jobs/face-index-poll.job'
import { processLivePhotoWorkerJob } from './jobs/live-photo-verify.job'
import {
  onFaceRegistrationVerifyJobFailed,
  processFaceRegistrationWorkerJob,
} from './jobs/face-registration-verify.job'
import { LIVE_PHOTO_VERIFY_QUEUE } from './queues/live-photo.constants'
import { FACE_REGISTRATION_QUEUE } from './queues/face-registration.constants'
import { livePhotoVerifyQueue } from './queues/live-photo.queue'
import { faceRegistrationQueue } from './queues/face-registration.queue'

async function main() {
  try {
    await ensureCollectionExists()
  } catch (error) {
    console.error('[face-rekognition-worker] Failed to ensure Rekognition collection exists', error)
    process.exit(1)
  }

  const connection = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
  await connection.connect()

  const livePhotoVerifyWorker = new Worker(
    LIVE_PHOTO_VERIFY_QUEUE,
    async (job: Job) => {
      await processLivePhotoWorkerJob(job)
    },
    { connection, concurrency: env.LIVE_PHOTO_WORKER_CONCURRENCY },
  )

  const faceRegistrationWorker = new Worker(
    FACE_REGISTRATION_QUEUE,
    async (job: Job) => {
      await processFaceRegistrationWorkerJob(job)
    },
    { connection, concurrency: env.FACE_REGISTRATION_WORKER_CONCURRENCY },
  )

  livePhotoVerifyWorker.on('failed', (job, err) => {
    console.error('[face-rekognition-worker] Live photo verify job failed:', job?.id, err)
  })
  faceRegistrationWorker.on('failed', (job, err) => {
    void onFaceRegistrationVerifyJobFailed(job, err).catch((handlerErr) => {
      console.error('[face-rekognition-worker] Face registration failure handler error', handlerErr)
    })
  })

  let running = true
  let cleaned = false

  const shutdown = async (exitCode = 0) => {
    if (cleaned) return
    cleaned = true
    running = false
    try {
      await withShutdownTimeout(async () => {
        await livePhotoVerifyWorker.close()
        await faceRegistrationWorker.close()
        await livePhotoVerifyQueue.close()
        await faceRegistrationQueue.close()
        await prisma.$disconnect()
        if (prismaRead !== prisma) await prismaRead.$disconnect()
        await connection.quit()
        await redisReadClient?.quit()
      })
    } catch (e) {
      console.error('[face-rekognition-worker] worker/queue close error', e)
    }
    process.exit(exitCode)
  }

  process.on('SIGINT', () => void shutdown(0))
  process.on('SIGTERM', () => void shutdown(0))

  registerCrashHandlers('face-rekognition-worker', shutdown)

  console.info(
    `[face-rekognition-worker] BullMQ: ${LIVE_PHOTO_VERIFY_QUEUE}, ${FACE_REGISTRATION_QUEUE}; Postgres poll every ${env.FACE_INDEX_POLL_MS}ms (batch ${env.FACE_INDEX_BATCH})`,
  )

  const pollChunkMs = 500

  while (running) {
    try {
      const n = await runFaceIndexPollOnce()
      if (n > 0) console.info(`[face-rekognition-worker] indexed batch (${n} row(s))`)
    } catch (error) {
      console.error('[face-rekognition-worker] poll cycle failed', error)
    }
    let left = env.FACE_INDEX_POLL_MS
    while (left > 0 && running) {
      const step = Math.min(pollChunkMs, left)
      await sleep(step)
      left -= step
    }
  }
}

main().catch((error) => {
  console.error('[face-rekognition-worker] fatal', error)
  process.exit(1)
})
