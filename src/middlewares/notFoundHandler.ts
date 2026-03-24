import { FastifyRequest, FastifyReply } from 'fastify'

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    statusCode: 404,
    error: 'Not Found',
    message: `Route ${request.method} ${request.url} not found`,
  })
}
