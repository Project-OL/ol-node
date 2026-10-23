import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHttpTestApp } from './helpers/http-test-app'

const queryRaw = vi.fn()
const redisPing = vi.fn()

vi.mock('../../src/config/database', () => ({
  prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) },
}))

vi.mock('../../src/config/redis', () => ({
  redisClient: { ping: (...a: unknown[]) => redisPing(...a) },
}))

vi.mock('../../src/config/env', async () => {
  const actual = await vi.importActual<typeof import('../../src/config/env')>('../../src/config/env')
  return {
    env: { ...actual.env, LAB_REQUEST_METRICS: false },
  }
})

import healthRoutes from '../../src/routes/v1/health.routes'

describe('HTTP contract: health routes', () => {
  let app: Awaited<ReturnType<typeof createHttpTestApp>>

  beforeEach(async () => {
    queryRaw.mockReset()
    redisPing.mockReset()
    app = await createHttpTestApp(healthRoutes, { prefix: '/health' })
  })

  afterEach(async () => {
    await app.close()
  })

  it('GET /health returns 200 liveness', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok' })
    // Phase 0 versioning: the build's commit (null outside a CI artifact).
    expect(res.json()).toHaveProperty('commit')
  })

  it('GET /health/ready returns 200 when DB and Redis are up', async () => {
    queryRaw.mockResolvedValue([{ '?column?': 1 }])
    redisPing.mockResolvedValue('PONG')
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ready' })
  })

  it('GET /health/ready returns 503 when DB fails', async () => {
    queryRaw.mockRejectedValue(new Error('db down'))
    redisPing.mockResolvedValue('PONG')
    const res = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toMatchObject({ status: 'not_ready' })
  })
})
