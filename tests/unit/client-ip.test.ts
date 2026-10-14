import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { clientIp } from '../../src/utils/client-ip'
import { redisReconnectOnError, redisRetryStrategy } from '../../src/config/redis'

/**
 * SEC-12: with the hop count set, a client-supplied X-Forwarded-For entry can't become request.ip
 * (the rate-limit key). Fastify inject connects from 127.0.0.1, standing in for the proxy socket.
 */
async function ipSeen(trustProxy: number | boolean, xff: string): Promise<string | undefined> {
  const app = Fastify({ trustProxy })
  app.get('/ip', async (req) => ({ ip: clientIp(req) }))
  const res = await app.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': xff } })
  await app.close()
  return res.json().ip
}

describe('SEC-12 client IP behind proxies', () => {
  it('GCP prod (2 hops: <client>, <lb-ip> appended): spoofed leftmost entry is ignored', async () => {
    // The client sent "1.2.3.4"; the LB appended the real client 203.0.113.7 and its own 35.191.0.1.
    expect(await ipSeen(2, '1.2.3.4, 203.0.113.7, 35.191.0.1')).toBe('203.0.113.7')
    // Rotating the forged value doesn't change the key.
    expect(await ipSeen(2, '5.6.7.8, 203.0.113.7, 35.191.0.1')).toBe('203.0.113.7')
    // No forged value at all.
    expect(await ipSeen(2, '203.0.113.7, 35.191.0.1')).toBe('203.0.113.7')
  })

  it('staging (1 hop: nginx appends $remote_addr): spoofed entry is ignored', async () => {
    expect(await ipSeen(1, '1.2.3.4, 198.51.100.9')).toBe('198.51.100.9')
  })

  it('unset (old trustProxy: true) still returns the leftmost entry, i.e. unchanged behaviour', async () => {
    expect(await ipSeen(true, '1.2.3.4, 203.0.113.7, 35.191.0.1')).toBe('1.2.3.4')
  })

  it('clientIp tolerates missing requests and blank ips', () => {
    expect(clientIp(undefined)).toBeUndefined()
    expect(clientIp({ ip: '  ' })).toBeUndefined()
    expect(clientIp({ ip: '10.0.0.1' })).toBe('10.0.0.1')
  })
})

describe('BE-18 Redis reconnect policy', () => {
  it('never gives up (the old strategy returned null after 5 attempts)', () => {
    for (const times of [1, 5, 6, 50, 10_000]) {
      const delay = redisRetryStrategy(times)
      expect(typeof delay).toBe('number')
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThanOrEqual(2100)
    }
  })

  it('reconnects on READONLY (failover) and not on other errors', () => {
    expect(redisReconnectOnError(new Error("READONLY You can't write against a read only replica."))).toBe(2)
    expect(redisReconnectOnError(new Error('WRONGTYPE Operation against a key'))).toBe(false)
  })
})
