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
    if (error.statusCode === 429 && error.details?.retryAfter != null) {
      reply.header('Retry-After', String(error.details.retryAfter))
    }
    if (error.statusCode === 429 && error.details?.nextChangeAt != null) {
      const next = new Date(String(error.details.nextChangeAt)).getTime()
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
