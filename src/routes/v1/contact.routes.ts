import { FastifyInstance } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'

export default async function contactRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
}
