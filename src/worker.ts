/**
 * Background job worker (BullMQ). Run as a separate process so API nodes stay stateless.
 *
 * Default (`WORKER_QUEUES=all`) consumes every queue except face/Rekognition
 * (`src/worker-face-index.ts`). For independent scale:
 *   - `npm run worker:realtime` — outbox, platform inbox, push, auto-reply, media
 *   - `npm run worker:general` — payroll, expiry, agency, live-session, …
 * Do not run `worker` (all) together with `worker:realtime` / `worker:general`
 * or the same queues get two consumer processes (safe but wasteful).
 */

import 'dotenv/config'
import Redis from 'ioredis'
import { env } from './config/env'
import { prisma, prismaRead } from './config/database'
import { redisReadClient } from './config/redis'
import { registerCrashHandlers } from './utils/crashHandlers'
import { withShutdownTimeout } from './utils/shutdownTimeout'
import type { WorkerFamily } from './workers/family'
import { startRealtimeWorkerFamily } from './workers/realtime.family'
import { startGeneralWorkerFamily } from './workers/general.family'

async function main() {
  const connection = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
  await connection.connect()

  const families: WorkerFamily[] = []
  if (env.WORKER_QUEUES === 'all' || env.WORKER_QUEUES === 'realtime') {
    families.push(await startRealtimeWorkerFamily(connection))
  }
  if (env.WORKER_QUEUES === 'all' || env.WORKER_QUEUES === 'general') {
    families.push(await startGeneralWorkerFamily(connection))
  }

  console.info(
    `Worker started (${env.WORKER_QUEUES}): ${families.map((f) => f.name).join(', ')}` +
      ' (face: `npm run worker:face-index`)',
  )

  const shutdown = async (exitCode = 0) => {
    await withShutdownTimeout(async () => {
      for (const family of families) {
        await family.close()
      }
      await prisma.$disconnect()
      if (prismaRead !== prisma) await prismaRead.$disconnect()
      await connection.quit()
      await redisReadClient?.quit()
    })
    process.exit(exitCode)
  }

  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))

  registerCrashHandlers('worker', shutdown)
}

main().catch((err) => {
  console.error('Worker failed to start:', err)
  process.exit(1)
})
