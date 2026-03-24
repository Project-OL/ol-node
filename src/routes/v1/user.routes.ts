import { FastifyInstance } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.get('/profile', async (_req, reply) => reply.send({ todo: 'user profile' }))
}