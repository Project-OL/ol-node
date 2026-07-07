/**
 * Parallel payment-method binds must never 5xx and must end with exactly one
 * row per (user, methodType) - last-writer-wins on the bound details.
 *
 * Live test - requires the API running locally + lab seed.
 * Run (PowerShell): $env:LAB_CONCURRENCY='1'; npm run lab:concurrency
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import * as fs from 'fs'
import * as path from 'path'
import bcrypt from 'bcrypt'
import dotenv from 'dotenv'

const RUN = process.env.LAB_CONCURRENCY === '1'
const envBase = process.env.LAB_BASE_URL || ''
const BASE = /^https?:\/\//.test(envBase) ? envBase : 'http://localhost:3000'
const PIN = '135790'

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

async function post(pathname: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-security-password': PIN,
    },
    body: JSON.stringify(body),
  })
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, body: parsed }
}

describe.skipIf(!RUN)('parallel binds: POST /api/v1/payment-methods/epay + /bank', () => {
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

    const pinHash = await bcrypt.hash(PIN, 12)
    await prisma.securityPassword.upsert({
      where: { userId },
      create: { userId, passwordHash: pinHash, failedAttempts: 0, lockedUntil: null },
      update: { passwordHash: pinHash, failedAttempts: 0, lockedUntil: null },
    })
    await redis.del(`ratelimit:pm:bind:${userId}`)
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('3 parallel EPAY binds (fresh account): no 5xx, exactly one row, one of the submitted emails wins', async () => {
    await prisma.userPaymentMethod.deleteMany({ where: { userId, methodType: 'EPAY' } })
    await redis.del(`ratelimit:pm:bind:${userId}`, `pmethods:${userId}`)

    const emails = [1, 2, 3].map((i) => `lab-epay-${i}@test.local`)
    const results = await Promise.all(
      emails.map((epayEmail) => post('/api/v1/payment-methods/epay', { epayEmail })),
    )
    const failed = results.filter((r) => r.status >= 500)
    expect(failed, `5xx: ${JSON.stringify(failed)}`).toHaveLength(0)

    const rows = await prisma.userPaymentMethod.findMany({
      where: { userId, methodType: 'EPAY' },
    })
    expect(rows).toHaveLength(1)
    expect(emails).toContain(rows[0]!.epayEmail)
  }, 60_000)

  it('3 parallel BANK binds (fresh): no 5xx, exactly one row', async () => {
    await prisma.userPaymentMethod.deleteMany({ where: { userId, methodType: 'BANK' } })
    await redis.del(`ratelimit:pm:bind:${userId}`, `pmethods:${userId}`)

    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        post('/api/v1/payment-methods/bank', {
          firstName: 'Lab',
          lastName: `User${i}`,
          bankName: 'Lab Bank',
          ifscCode: 'LAB00001',
          accountNumber: `10000000${i}`,
        }),
      ),
    )
    const failed = results.filter((r) => r.status >= 500)
    expect(failed, `5xx: ${JSON.stringify(failed)}`).toHaveLength(0)

    const rows = await prisma.userPaymentMethod.findMany({
      where: { userId, methodType: 'BANK' },
    })
    expect(rows).toHaveLength(1)
  }, 60_000)
})
