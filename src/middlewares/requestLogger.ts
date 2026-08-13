import { FastifyRequest, FastifyReply } from 'fastify'
import { env } from '../config/env'

function requestPath(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

export function isHealthPath(url: string): boolean {
  const path = requestPath(url)
  return path === '/health' || path.startsWith('/health/')
}

export async function requestIdHook(request: FastifyRequest, _reply: FastifyReply) {
  const id = (request.headers['x-request-id'] as string | undefined) ?? request.id
  request.log = request.log.child({ requestId: id, traceId: id })
}

export async function requestLoggerHook(request: FastifyRequest, _reply: FastifyReply) {
  if (isHealthPath(request.url)) return
  if (env.REQUEST_LOG_SAMPLE_RATE < 1 && Math.random() >= env.REQUEST_LOG_SAMPLE_RATE) return
  request.log.info({ method: request.method, url: request.url }, 'incoming request')
}
