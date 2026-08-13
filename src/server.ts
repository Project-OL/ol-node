import { buildApp } from './app'
import { env } from './config/env'
import { prisma, prismaRead, connectDatabases } from './config/database'
import { redisClient, redisReadClient } from './config/redis'
import { ensureCollectionExists } from './lib/rekognition.client'
import { withShutdownTimeout } from './utils/shutdownTimeout'

async function start() {
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

  const shutdown = async (signal: string, options: { exitCode: number }) => {
    try {
      app.log.info({ signal }, 'Shutting down gracefully...')
      await withShutdownTimeout(async () => {
        await app.close()
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
