import Fastify, { type FastifyInstance } from 'fastify'
import crypto from 'crypto'
import { env } from '../config/env'
import { logger } from '../config/logger'
import { rootLogger } from '../utils/rootLogger'
import { AppError, errorHandler } from '../middlewares/errorHandler'
import { internalLedgerRoutes } from '../routes/internal/ledger.routes'
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyInternalRequest } from './hmac'

/**
 * BE-20: the internal API (service-to-service only).
 *
 * A separate Fastify instance on its own listener (INTERNAL_API_HOST:INTERNAL_API_PORT, default
 * 127.0.0.1:3101). The public port is the only one the GCP load balancer and staging nginx proxy
 * to, so these routes are unreachable from outside even if a URL map rule were wrong. Every
 * request except GET /internal/health must carry a valid HMAC signature (src/internal/hmac.ts).
 */
export async function buildInternalApp(secret: string): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: 64 * 1024,
    keepAliveTimeout: 65_000,
  })

  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )

  // Requests whose signature the body parser verified. Anything else never reaches a handler.
  const verified = new WeakSet<object>()

  // Keep the raw body: the signature covers the exact bytes Live-server sent.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8')
    const path = (req.url ?? '').split('?')[0] ?? ''
    const verdict = verifyInternalRequest(secret, {
      signature: req.headers[SIGNATURE_HEADER] as string | undefined,
      timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
      method: req.method,
      path,
      body: raw,
    })
    if (!verdict.ok) {
      req.log.warn({ reason: verdict.reason, path }, 'internal API signature rejected')
      done(new AppError(401, 'Unauthorized', 'INTERNAL_SIGNATURE_INVALID'), undefined)
      return
    }
    let parsed: unknown
    try {
      parsed = raw.length ? JSON.parse(raw) : {}
    } catch {
      done(new AppError(400, 'Invalid JSON', 'INVALID_REQUEST'), undefined)
      return
    }
    verified.add(req)
    done(null, parsed)
  })

  // A request without a JSON body never reaches the parser above, so it was never verified.
  app.addHook('preHandler', async (req) => {
    if (req.method === 'GET' && req.url === '/internal/health') return
    if (!verified.has(req)) {
      throw new AppError(401, 'Unauthorized', 'INTERNAL_SIGNATURE_INVALID')
    }
  })

  app.setErrorHandler(errorHandler)

  app.get('/internal/health', async () => ({ ok: true }))
  await app.register(internalLedgerRoutes, { prefix: '/internal/v1/ledger' })
  return app
}

/** Start the internal listener when its secret is configured. Returns null when disabled. */
export async function startInternalApi(): Promise<FastifyInstance | null> {
  const secret = env.INTERNAL_LEDGER_HMAC_SECRET
  if (!secret) {
    rootLogger.info('internal API disabled (INTERNAL_LEDGER_HMAC_SECRET not set)')
    return null
  }
  const app = await buildInternalApp(secret)
  await app.listen({ port: env.INTERNAL_API_PORT, host: env.INTERNAL_API_HOST })
  app.log.info(`internal API on ${env.INTERNAL_API_HOST}:${env.INTERNAL_API_PORT}`)
  return app
}
