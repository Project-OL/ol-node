import { FastifyRequest, FastifyReply } from 'fastify'

export async function requestIdHook(request: FastifyRequest, _reply: FastifyReply) {
  const id = request.headers['x-request-id'] as string | undefined ?? request.id
  request.log = request.log.child({ requestId: id, traceId: id })
}

export async function requestLoggerHook(request: FastifyRequest, _reply: FastifyReply) {
  request.log.info({ method: request.method, url: request.url }, 'incoming request')
}
