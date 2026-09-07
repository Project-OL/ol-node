import { FastifyInstance } from 'fastify'
import { prisma } from '../../config/database'
import { redisClient } from '../../config/redis'
import { env } from '../../config/env'
import { storageTarget } from '../../config/s3'
import { requestMetrics } from '../../utils/requestMetrics'

export default async function healthRoutes(app: FastifyInstance) {
  /** Liveness: cheap, no dependencies. Use for process health. */
  app.get('/', async (_request, reply) => {
    return reply.send({ status: 'okkkkkk', timestamp: new Date().toISOString() })
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
      // Additive, credential-free. Lets any environment be checked with one curl:
      // provider must be `aws-s3` on prodv2/staging and `s3-compatible` on GCP.
      storage: {
        provider: storageTarget.provider,
        bucket: storageTarget.bucket,
        region: storageTarget.region,
      },
      ...(Object.keys(checks).length > 0 && { checks }),
    })
  })

  if (env.LAB_REQUEST_METRICS) {
    app.get('/metrics', async (_request, reply) => {
      return reply.send({
        source: 'server',
        unit: 'ms',
        routes: requestMetrics.snapshot(),
        timestamp: new Date().toISOString(),
      })
    })
  }
}
