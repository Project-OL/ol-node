import type { FastifyReply, FastifyRequest } from 'fastify'
import { env } from '../config/env'
import { labRequestContext } from '../utils/labRequestContext'
import { requestMetrics } from '../utils/requestMetrics'

type TimedRequest = FastifyRequest & {
  _startMs?: number
  _labIo?: { dbQueries: number; redisOps: number }
}

export async function requestTimingOnRequest(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  ;(request as TimedRequest)._startMs = Date.now()
  if (env.LAB_REQUEST_METRICS) {
    labRequestContext.startRequest()
  }
}

export async function requestTimingOnSend(
  request: FastifyRequest,
  _reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if (!env.LAB_REQUEST_METRICS) return payload

  const timed = request as TimedRequest
  const startMs = timed._startMs
  if (startMs == null) return payload

  const durationMs = Date.now() - startMs
  const io = labRequestContext.snapshot()
  timed._labIo = io

  _reply.header('X-Lab-Duration-Ms', String(durationMs))
  _reply.header('X-Lab-Db-Queries', String(io.dbQueries))
  _reply.header('X-Lab-Redis-Ops', String(io.redisOps))
  return payload
}

export async function requestTimingOnResponse(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const timed = request as TimedRequest
  const startMs = timed._startMs
  if (startMs == null) return

  const durationMs = Date.now() - startMs
  const route =
    (request.routeOptions as { url?: string } | undefined)?.url ??
    (request as FastifyRequest & { routerPath?: string }).routerPath

  const io = timed._labIo ?? (env.LAB_REQUEST_METRICS ? labRequestContext.snapshot() : undefined)

  request.log.info(
    {
      durationMs,
      statusCode: reply.statusCode,
      route: route ?? request.url.split('?')[0],
      ...(io && { dbQueries: io.dbQueries, redisOps: io.redisOps }),
    },
    'request completed',
  )

  if (env.LAB_REQUEST_METRICS) {
    requestMetrics.record(request.method, route, request.url, durationMs, io)
  }
}
