/**
 * Payroll / expiry / agency / live-session BullMQ process. Pair with `src/worker-realtime.ts`.
 */
import 'dotenv/config'
import Redis from 'ioredis'
import { env } from './config/env'
import { prisma, prismaRead } from './config/database'
import { redisReadClient } from './config/redis'
import { registerCrashHandlers } from './utils/crashHandlers'
import { withShutdownTimeout } from './utils/shutdownTimeout'
import { startGeneralWorkerFamily } from './workers/general.family'

async function main() {
  const connection = new Redis(env.REDIS_URL, {
    password: env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
  await connection.connect()

  const family = await startGeneralWorkerFamily(connection)
  console.info('Worker started (general): payroll, expiry, agency, live-session, rankings')

  const shutdown = async (exitCode = 0) => {
    await withShutdownTimeout(async () => {
      await family.close()
      await prisma.$disconnect()
      if (prismaRead !== prisma) await prismaRead.$disconnect()
      await connection.quit()
      await redisReadClient?.quit()
    })
    process.exit(exitCode)
  }

  process.on('SIGTERM', () => void shutdown(0))
  process.on('SIGINT', () => void shutdown(0))

  registerCrashHandlers('worker-general', shutdown)
}

main().catch((err) => {
  console.error('General worker failed to start:', err)
  process.exit(1)
})
