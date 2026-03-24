import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'
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

export function errorHandler(
  error: FastifyError | AppError,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof AppError) {
    const message = env.NODE_ENV === 'production' ? undefined : error.message
    if (error.statusCode === 429 && error.details?.retryAfter != null) {
      reply.header('Retry-After', String(error.details.retryAfter))
    }
    return reply.status(error.statusCode).send({
      statusCode: error.statusCode,
      ...(message != null && { error: message }),
      code: error.code,
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
