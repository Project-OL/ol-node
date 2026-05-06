import { buildApp } from './app'
import { env } from './config/env'
import { prisma } from './config/database'
import { redisClient } from './config/redis'
import { ensureCollectionExists } from './lib/rekognition.client'

async function start() {
  try {
    await ensureCollectionExists()
  } catch (error) {
    console.error('Failed to ensure Rekognition collection exists', error)
    process.exit(1)
  }

  const app = await buildApp()

  const shutdown = async (signal: string, options: { exitCode: number }) => {
    try {
      app.log.info({ signal }, 'Shutting down gracefully...')
      await app.close()
      await prisma.$disconnect()
      await redisClient.quit()
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
