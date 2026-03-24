import { FastifyInstance } from 'fastify'

export default async function callRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => reply.send({ calls: [] }))
}
