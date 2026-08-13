import Fastify from 'fastify'
import crypto from 'crypto'
import helmet from '@fastify/helmet'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { env } from './config/env'
import { logger } from './config/logger'
import { errorHandler } from './middlewares/errorHandler'
import { notFoundHandler } from './middlewares/notFoundHandler'
import { requestIdHook, requestLoggerHook } from './middlewares/requestLogger'
import healthRoutes from './routes/v1/health.routes'
import { registerRealtimeGateway } from './realtime/ws.gateway'

/**
 * Slim Fastify app: health + GET /ws. Tickets are minted by the API
 * (`POST /auth/ws-ticket`) and consumed here via Redis GETDEL.
 */
export async function buildWsApp() {
  const app = Fastify({
    logger,
    genReqId: () => crypto.randomUUID(),
    trustProxy: true,
    keepAliveTimeout: 30_000,
  })

  await app.register(websocket)
  await app.register(helmet, {
    contentSecurityPolicy: env.NODE_ENV === 'production',
  })

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true)
        return
      }
      if (env.ALLOWED_ORIGINS.includes(origin)) {
        callback(null, origin)
        return
      }
      callback(null, false)
    },
    credentials: true,
  })

  app.addHook('onRequest', requestIdHook)
  app.addHook('onRequest', requestLoggerHook)
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler(notFoundHandler)

  await app.register(healthRoutes, { prefix: '/health' })
  registerRealtimeGateway(app)

  app.get('/', async (_request, reply) => {
    return reply.send({ service: 'ws', status: 'ok' })
  })

  return app
}
