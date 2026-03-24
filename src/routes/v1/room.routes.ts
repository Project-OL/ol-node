import { FastifyInstance } from 'fastify'

export default async function roomRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => reply.send({ rooms: [] }))
}
