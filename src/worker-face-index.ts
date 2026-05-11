/**
 * Standalone process: polls Postgres for `user_face_profiles` in `PENDING_INDEX`
 * and indexes faces in Rekognition. Does **not** connect to Redis or BullMQ.
 *
 * Run alongside the API (or alone) when you want indexing without the full `worker.ts`.
 */
import 'dotenv/config'
import { setTimeout as sleep } from 'node:timers/promises'
import { env } from './config/env'
import { prisma } from './config/database'
import { ensureCollectionExists } from './lib/rekognition.client'
import { runFaceIndexPollOnce } from './jobs/face-index-poll.job'

async function main() {
  try {
    await ensureCollectionExists()
  } catch (error) {
    console.error('[face-index-worker] Failed to ensure Rekognition collection exists', error)
    process.exit(1)
  }

  let running = true
  const shutdown = async () => {
    running = false
    await prisma.$disconnect()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  console.info(
    `[face-index-worker] started (poll ${env.FACE_INDEX_POLL_MS}ms, batch ${env.FACE_INDEX_BATCH}); no Redis/BullMQ`,
  )

  while (running) {
    try {
      const n = await runFaceIndexPollOnce()
      if (n > 0) console.info(`[face-index-worker] indexed batch (${n} row(s))`)
    } catch (error) {
      console.error('[face-index-worker] poll cycle failed', error)
    }
    await sleep(env.FACE_INDEX_POLL_MS)
  }
}

main().catch((error) => {
  console.error('[face-index-worker] fatal', error)
  process.exit(1)
})
