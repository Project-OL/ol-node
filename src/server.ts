import './observability/tracing' // OBS-06: must stay first (no-op unless OTEL_TRACING=on)
import { buildApp } from './app'
import { env } from './config/env'
import { prisma, prismaRead, connectDatabases } from './config/database'
import { redisClient, redisReadClient } from './config/redis'
import { ensureCollectionExists } from './lib/rekognition.client'
import { describeStorageTarget } from './config/s3'
import { withShutdownTimeout } from './utils/shutdownTimeout'
import { startInternalApi } from './internal/internal-app'

async function start() {
  // Log the resolved object-storage target first. Which store a process talks to is
  // decided by .env, never by the code, so a host whose env does not match its
  // environment - a GCP box missing S3_ENDPOINT_URL quietly writing uploads into the
  // AWS bucket - is otherwise invisible until objects turn up missing.
  console.log(`[storage] ${describeStorageTarget()}`)

  try {
    await connectDatabases()
  } catch (error) {
    console.error('Failed to connect to database', error)
    process.exit(1)
  }

  try {
    await ensureCollectionExists()
  } catch (error) {
    console.error(
      'Rekognition collection ensure failed (API continues; face worker owns indexing)',
      error,
    )
  }

  const app = await buildApp()
  let internalApp: Awaited<ReturnType<typeof startInternalApi>> = null

  const shutdown = async (signal: string, options: { exitCode: number }) => {
    try {
      app.log.info({ signal }, 'Shutting down gracefully...')
      await withShutdownTimeout(async () => {
        await app.close()
        await internalApp?.close()
        await prisma.$disconnect()
        if (prismaRead !== prisma) await prismaRead.$disconnect()
        await redisClient.quit()
        await redisReadClient?.quit()
      })
      app.log.info('All connections closed. Exiting.')
    } catch (err) {
      app.log.error({ err }, 'Error during shutdown')
    } finally {
      process.exit(options.exitCode)
    }
  }

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' })
    app.log.info(`🚀 API running on port ${env.PORT}`)
    // BE-20 internal ledger API for Live-server (loopback/private listener, HMAC-signed).
    // Its failure must not take the public API down: Live-server stays on LIVE_LEDGER_MODE=local.
    internalApp = await startInternalApi().catch((err) => {
      app.log.error({ err }, 'internal API failed to start')
      return null
    })
  } catch (err) {
    app.log.error(err)
    await shutdown('LISTEN_ERROR', { exitCode: 1 })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM', { exitCode: 0 }))
  process.on('SIGINT', () => shutdown('SIGINT', { exitCode: 0 }))

  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught exception, shutting down')
    void shutdown('UNCAUGHT_EXCEPTION', { exitCode: 1 })
  })

  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'Unhandled promise rejection, shutting down')
    void shutdown('UNHANDLED_REJECTION', { exitCode: 1 })
  })
}

start()
