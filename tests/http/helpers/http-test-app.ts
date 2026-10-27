/**
 * HTTP contract test helpers — register route plugins on a minimal Fastify app.
 */
import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import { ZodError } from 'zod'
import { AppError } from '../../../src/middlewares/errorHandler'

export const TEST_USER_ID = '00000000-0000-4000-8000-000000000001'
export const TEST_JWT_SECRET = 'test-secret-at-least-32-characters-long'

export async function createHttpTestApp(
  register: (app: FastifyInstance) => Promise<void>,
  options?: { prefix?: string },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })
  await app.register(jwt, {
    secret: TEST_JWT_SECRET,
    sign: { algorithm: 'HS256', expiresIn: '15m' },
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
      })
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: 'INVALID_REQUEST',
        message: error.errors[0]?.message ?? 'Validation failed',
      })
    }
    if (error && typeof error === 'object' && 'validation' in error) {
      return reply.status(400).send({
        code: 'INVALID_REQUEST',
        message: 'Validation failed',
      })
    }
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal error' })
  })
  if (options?.prefix) {
    await app.register(register, { prefix: options.prefix })
  } else {
    await register(app)
  }
  await app.ready()
  return app
}

export function authHeader(userId = TEST_USER_ID): { authorization: string } {
  return { authorization: `Bearer test-token-${userId}` }
}