import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/database'
import { redisClient } from '../../config/redis'

export default async function healthRoutes(app: FastifyInstance) {
  /** Liveness: cheap, no dependencies. Use for process health. */
  app.get('/', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() })
  })

  /** Readiness: DB + Redis. Use for orchestrator readiness (e.g. Kubernetes). */
  app.get('/ready', async (_request, reply) => {
    const checks: { db?: string; redis?: string } = {}
    try {
      await prisma.$queryRaw`SELECT 1`
    } catch (err) {
      checks.db = err instanceof Error ? err.message : 'unknown'
    }
    try {
      await redisClient.ping()
    } catch (err) {
      checks.redis = err instanceof Error ? err.message : 'unknown'
    }
    const ok = !checks.db && !checks.redis
    return reply.status(ok ? 200 : 503).send({
      status: ok ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      ...(Object.keys(checks).length > 0 && { checks }),
    })
  })
}
