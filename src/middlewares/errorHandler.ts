import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { ZodError } from 'zod'
import { env } from '../config/env'

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AppError'
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

/**
 * Client-input failures that escaped a route's own handling (a bare `Schema.parse`, or a value
 * too long for its DB column) are 400s, not 500s: same body shape as `parseRequest`.
 */
function toClientInputError(error: unknown): AppError | null {
  if (error instanceof ZodError) {
    const issues = error.errors.map((e) => ({ path: e.path.join('.'), message: e.message }))
    const first = issues[0]
    const message = first
      ? first.path
        ? `${first.path}: ${first.message}`
        : first.message
      : 'Invalid request'
    return new AppError(400, message, 'INVALID_REQUEST', { issues })
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2000') {
    const column = (error.meta as { column_name?: string } | undefined)?.column_name
    return new AppError(
      400,
      column ? `Value too long for ${column}` : 'A value is too long',
      'VALUE_TOO_LONG',
    )
  }
  return null
}

export function errorHandler(
  error: FastifyError | AppError,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  const clientError = toClientInputError(error)
  if (clientError) {
    reply.log.info({ err: error }, clientError.message)
    error = clientError
  }
  if (error instanceof AppError) {
    if (error.statusCode === 429 && error.details?.retryAfter != null) {
      reply.header('Retry-After', String(error.details.retryAfter))
    }
    if (error.statusCode === 429 && error.details?.nextChangeAt != null) {
      const next = new Date(String(error.details.nextChangeAt)).getTime()
      const sec = Math.max(0, Math.ceil((next - Date.now()) / 1000))
      if (sec > 0) reply.header('Retry-After', String(sec))
    }
    if (error.statusCode === 429 && error.details?.nextAllowedAt != null) {
      const next = new Date(String(error.details.nextAllowedAt)).getTime()
      const sec = Math.max(0, Math.ceil((next - Date.now()) / 1000))
      if (sec > 0) reply.header('Retry-After', String(sec))
    }
    const errCode = error.code ?? 'ERROR'
    return reply.status(error.statusCode).send({
      statusCode: error.statusCode,
      error: errCode,
      code: errCode,
      message: error.message,
      ...(error.details != null && { details: error.details }),
    })
  }

  const statusCode = error.statusCode ?? 500
  const safeMessage =
    statusCode >= 500 && env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : (error.message ?? 'Internal Server Error')
  reply.log.error({ err: error }, error.message ?? 'Internal Server Error')
  return reply.status(statusCode).send({
    statusCode,
    error: safeMessage,
  })
}
