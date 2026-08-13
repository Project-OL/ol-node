import { buildWsApp } from './ws-app'
import { env } from './config/env'
import { prisma, prismaRead, connectDatabases } from './config/database'
import { redisClient, redisReadClient } from './config/redis'
import { messagingService } from './services/messaging.service'
import { withShutdownTimeout } from './utils/shutdownTimeout'

async function start() {
  try {
    await connectDatabases()
  } catch (error) {
    console.error('Failed to connect to database', error)
    process.exit(1)
  }

  const app = await buildWsApp()

  const shutdown = async (signal: string, options: { exitCode: number }) => {
    try {
      app.log.info({ signal }, 'WS shutting down gracefully...')
      // Flush pending read-receipt debounce timers before the socket layer
      // closes — they only live in this process, so a rolling deploy mid-
      // debounce would otherwise silently drop the receipt.
      await messagingService.flushAllPendingReadReceipts().catch((err) => {
        app.log.warn({ err }, 'flushAllPendingReadReceipts failed during shutdown')
      })
      await withShutdownTimeout(async () => {
        await app.close()
        await prisma.$disconnect()
        if (prismaRead !== prisma) await prismaRead.$disconnect()
        await redisClient.quit()
        await redisReadClient?.quit()
      })
      app.log.info('WS connections closed. Exiting.')
    } catch (err) {
      app.log.error({ err }, 'Error during WS shutdown')
    } finally {
      process.exit(options.exitCode)
    }
  }

  try {
    await app.listen({ port: env.WS_PORT, host: '0.0.0.0' })
    app.log.info(`WS gateway listening on port ${env.WS_PORT} (GET /ws)`)
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
