/**
 * CRITICAL: the VIP daily grant is idempotent per UTC day - N parallel claims
 * must credit exactly once; losers get 409 ALREADY_CLAIMED_TODAY, never 5xx.
 *
 * Live test - requires the API running locally plus seeded lab user.
 * Run (PowerShell): $env:LAB_CONCURRENCY='1'; npm run lab:concurrency
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import * as fs from 'fs'
import * as path from 'path'
import dotenv from 'dotenv'

const RUN = process.env.LAB_CONCURRENCY === '1'
const envBase = process.env.LAB_BASE_URL || ''
const BASE = /^https?:\/\//.test(envBase) ? envBase : 'http://localhost:3000'
const GRANT = 35_000n

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

let token = ''
let userId = ''

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

async function claim(): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}/api/v1/vip-membership/claim-daily`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, body }
}

describe.skipIf(!RUN)('idempotent daily grant: POST /api/v1/vip-membership/claim-daily', () => {
  beforeAll(async () => {
    await redis.connect()
    const rlKeys = (await redis.keys('ratelimit:login:*')).concat(
      await redis.keys('ratelimit:auth:*'),
    )
    if (rlKeys.length > 0) await redis.del(...rlKeys)

    const login = await fetch(`${BASE}/api/v1/auth/login/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'email',
        identifier: process.env.LAB_EMAIL || 'lab-user-1@test.local',
        password: process.env.LAB_PASSWORD || 'LabPassword123!',
        deviceId: 'lab-conc-device-0001',
        deviceName: 'lab-concurrency',
      }),
    })
    expect(login.status).toBe(200)
    const loginBody = (await login.json()) as { accessToken: string; userId: string }
    token = loginBody.accessToken
    userId = loginBody.userId

    // Ensure active membership; clear today's claim + throttles so the test is repeatable.
    await prisma.user.update({
      where: { id: userId },
      data: {
        vipSubscriptionActive: true,
        vipSubscriptionStartAt: new Date(Date.now() - 86_400_000),
        vipSubscriptionExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    })
    await prisma.vipDailyClaim.deleteMany({
      where: { userId, claimDate: new Date(`${todayUtc()}T00:00:00.000Z`) },
    })
    await redis.del(`vipm:active:${userId}`)
    await redis.del(`ratelimit:vip-membership:claim:${userId}`)
    await redis.del(`wallet:coins:${userId}`)
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('4 parallel claims: exactly one 200 with the grant, losers 409, no 5xx; single ledger credit', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => claim()))

    const ok = results.filter((r) => r.status === 200)
    const dup = results.filter((r) => r.status === 409 && r.body?.code === 'ALREADY_CLAIMED_TODAY')
    const other = results.filter((r) => r.status !== 200 && r.status !== 409)

    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)
    expect(ok).toHaveLength(1)
    expect(dup).toHaveLength(3)
    expect(ok[0]!.body).toEqual({ amount: GRANT.toString(), claimDate: todayUtc() })

    // The per-day ledger key must exist exactly once, ever.
    const credits = await prisma.coinLedgerEntry.count({
      where: { idempotencyKey: `vip-daily-claim:${userId}:${todayUtc()}` },
    })
    expect(credits).toBe(1)

    const claims = await prisma.vipDailyClaim.count({
      where: { userId, claimDate: new Date(`${todayUtc()}T00:00:00.000Z`) },
    })
    expect(claims).toBe(1)
  }, 120_000)

  it('sequential duplicate claim returns 409 ALREADY_CLAIMED_TODAY', async () => {
    const r = await claim()
    expect(r.status).toBe(409)
    expect(r.body?.code).toBe('ALREADY_CLAIMED_TODAY')
  }, 60_000)
})
