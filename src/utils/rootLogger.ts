import pino from 'pino'
import { env } from '../config/env'

/** Pino instance for services that are not passed a Fastify logger. */
export const rootLogger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  }),
})
