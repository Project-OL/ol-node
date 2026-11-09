import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'

/** In-memory stand-in for the Redis INCR/EXPIRE pipeline the limiters use. */
const { store } = vi.hoisted(() => ({ store: new Map<string, number>() }))

vi.mock('../../src/config/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/redis')>()
  const pipeline = () => {
    const ops: Array<() => [null, number]> = []
    const p = {
      incr(key: string) {
        ops.push(() => {
          const v = (store.get(key) ?? 0) + 1
          store.set(key, v)
          return [null, v]
        })
        return p
      },
      expire() {
        ops.push(() => [null, 1])
        return p
      },
      async exec() {
        return ops.map((op) => op())
      },
    }
    return p
  }
  return { ...actual, redisClient: { pipeline } }
})

import { rateLimitSubject, identifierBucket } from '../../src/utils/rate-limit-subject'
import { createAuthRateLimit } from '../../src/middlewares/rateLimitAuth'
import { signAccess } from '../../src/utils/jwt'

type Req = Parameters<typeof rateLimitSubject>[0]

function req(opts: { ip?: string; auth?: string; body?: unknown; userId?: string } = {}): Req {
  return {
    ip: opts.ip ?? '203.0.113.7',
    headers: opts.auth ? { authorization: opts.auth } : {},
    body: opts.body,
    userId: opts.userId,
  } as unknown as Req
}

const reply = {} as never

async function status(handler: ReturnType<typeof createAuthRateLimit>, r: Req): Promise<number> {
  try {
    await handler(r as never, reply)
    return 200
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? 500
  }
}

beforeEach(() => store.clear())

describe('SEC-18 global limiter subject', () => {
  it('a valid access token is counted per user, not per IP', () => {
    const token = signAccess({ userId: 'user-1', sub: 'user-1', jti: 'j1' } as never)
    expect(rateLimitSubject(req({ auth: `Bearer ${token}` })).key).toBe('u:user-1')
  })

  it('two users behind one carrier IP get separate buckets', () => {
    const a = signAccess({ userId: 'a', sub: 'a', jti: 'j' } as never)
    const b = signAccess({ userId: 'b', sub: 'b', jti: 'j' } as never)
    const ip = '106.214.8.199'
    expect(rateLimitSubject(req({ ip, auth: `Bearer ${a}` })).key).not.toBe(
      rateLimitSubject(req({ ip, auth: `Bearer ${b}` })).key,
    )
  })

  it('no token, a garbage token or a forged (wrong-secret) token falls back to the IP', () => {
    expect(rateLimitSubject(req()).key).toBe('ip:203.0.113.7')
    expect(rateLimitSubject(req({ auth: 'Bearer not-a-jwt' })).key).toBe('ip:203.0.113.7')
    const forged = jwt.sign({ userId: 'made-up' }, 'attacker-secret-that-is-long-enough!!')
    expect(rateLimitSubject(req({ auth: `Bearer ${forged}` })).key).toBe('ip:203.0.113.7')
  })

  it('an expired token falls back to the IP', () => {
    const expired = signAccess({ userId: 'u', sub: 'u', jti: 'j' } as never, '-10s')
    expect(rateLimitSubject(req({ auth: `Bearer ${expired}` })).key).toBe('ip:203.0.113.7')
  })
})

describe('SEC-18 global @fastify/rate-limit wiring (same options as app.ts, in-memory store)', () => {
  async function build(userMax: number, anonMax: number) {
    const Fastify = (await import('fastify')).default
    const rateLimit = (await import('@fastify/rate-limit')).default
    const app = Fastify()
    await app.register(rateLimit, {
      max: (_req, key) => (key.startsWith('u:') ? userMax : anonMax),
      timeWindow: 60_000,
      keyGenerator: (r) => rateLimitSubject(r).key,
    })
    app.get('/x', async () => ({ ok: true }))
    app.get('/loc', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }))
    await app.ready()
    return app
  }
  const hit = (app: Awaited<ReturnType<typeof build>>, url: string, token?: string) =>
    app
      .inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then((r) => r.statusCode)

  it('users on one IP no longer share a bucket; anonymous traffic does', async () => {
    const app = await build(2, 3)
    const a = signAccess({ userId: 'a', sub: 'a', jti: 'j' } as never)
    const b = signAccess({ userId: 'b', sub: 'b', jti: 'j' } as never)
    expect([await hit(app, '/x', a), await hit(app, '/x', a), await hit(app, '/x', a)]).toEqual([200, 200, 429])
    expect(await hit(app, '/x', b)).toBe(200) // same inject IP, different user
    expect([await hit(app, '/x'), await hit(app, '/x'), await hit(app, '/x'), await hit(app, '/x')]).toEqual([
      200, 200, 200, 429,
    ])
    await app.close()
  })

  it('a route-level max override is still applied per user', async () => {
    const app = await build(100, 100)
    const a = signAccess({ userId: 'a', sub: 'a', jti: 'j' } as never)
    const b = signAccess({ userId: 'b', sub: 'b', jti: 'j' } as never)
    expect([await hit(app, '/loc', a), await hit(app, '/loc', a)]).toEqual([200, 429])
    expect(await hit(app, '/loc', b)).toBe(200)
    await app.close()
  })
})

describe('SEC-18 identifier buckets', () => {
  it('phone formatting and email casing map to one bucket', () => {
    expect(identifierBucket('+91 98765-43210')).toBe(identifierBucket('+919876543210'))
    expect(identifierBucket(' Abc@Gmail.com ')).toBe(identifierBucket('abc@gmail.com'))
    expect(identifierBucket('+919876543210')).not.toBe(identifierBucket('+919876543211'))
  })

  it('no PII in the bucket id; non-strings are rejected', () => {
    expect(identifierBucket('+919876543210')).toMatch(/^[0-9a-f]{32}$/)
    expect(identifierBucket(undefined)).toBeUndefined()
    expect(identifierBucket(42)).toBeUndefined()
    expect(identifierBucket('   ')).toBeUndefined()
  })
})

describe('SEC-18 auth endpoint limiter', () => {
  const sendOtp = createAuthRateLimit({
    endpoint: 'test.send_otp',
    max: 5,
    ipMax: 20,
    subjectField: 'identifier',
    windowMs: 600_000,
  })

  it('many different phones behind one carrier IP all get through (up to ipMax)', async () => {
    const ip = '106.214.8.199'
    for (let i = 0; i < 20; i++) {
      expect(await status(sendOtp, req({ ip, body: { identifier: `+9190000000${10 + i}` } }))).toBe(200)
    }
    // The IP ceiling still caps SMS pumping from one host.
    expect(await status(sendOtp, req({ ip, body: { identifier: '+919000000099' } }))).toBe(429)
  })

  it('one phone is capped at max even when the attacker rotates IPs', async () => {
    for (let i = 0; i < 5; i++) {
      expect(await status(sendOtp, req({ ip: `198.51.100.${i}`, body: { identifier: '+919876543210' } }))).toBe(200)
    }
    expect(await status(sendOtp, req({ ip: '198.51.100.200', body: { identifier: '+91 98765 43210' } }))).toBe(429)
  })

  it('a body without the identifier is counted against the IP ceiling only', async () => {
    for (let i = 0; i < 20; i++) expect(await status(sendOtp, req({ body: {} }))).toBe(200)
    expect(await status(sendOtp, req({ body: {} }))).toBe(429)
  })

  it('after authenticate, the bucket is per user (old per-IP behaviour gone)', async () => {
    const bind = createAuthRateLimit({ endpoint: 'test.bind', max: 2, windowMs: 86_400_000 })
    const ip = '106.214.8.199'
    expect(await status(bind, req({ ip, userId: 'a' }))).toBe(200)
    expect(await status(bind, req({ ip, userId: 'a' }))).toBe(200)
    expect(await status(bind, req({ ip, userId: 'a' }))).toBe(429)
    expect(await status(bind, req({ ip, userId: 'b' }))).toBe(200)
  })

  it('without subjectField it stays a plain per-IP limit at max', async () => {
    const plain = createAuthRateLimit({ endpoint: 'test.plain', max: 2, windowMs: 60_000 })
    expect(await status(plain, req())).toBe(200)
    expect(await status(plain, req())).toBe(200)
    expect(await status(plain, req())).toBe(429)
  })
})
