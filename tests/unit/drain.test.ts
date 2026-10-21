import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import { drainFor, isDraining, resetDrainForTests } from '../../src/utils/drain'

// Deploy-time 503s: while draining, every response retires its connection.
describe('graceful drain', () => {
  afterEach(() => resetDrainForTests())

  it('is off by default and with 0 ms', async () => {
    expect(isDraining()).toBe(false)
    await drainFor(0)
    expect(isDraining()).toBe(false)
  })

  it('marks responses Connection: close only while draining', async () => {
    const app = Fastify()
    app.addHook('onSend', async (_req, reply, payload) => {
      if (isDraining()) reply.header('connection', 'close')
      return payload
    })
    app.get('/x', async () => ({ ok: true }))
    await app.ready()

    const before = await app.inject({ method: 'GET', url: '/x' })
    expect(before.headers.connection).not.toBe('close')

    const t0 = Date.now()
    const drained = drainFor(50)
    expect(isDraining()).toBe(true)
    const during = await app.inject({ method: 'GET', url: '/x' })
    expect(during.statusCode).toBe(200) // still served, just not kept alive
    expect(during.headers.connection).toBe('close')
    await drained
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    await app.close()
  })
})
