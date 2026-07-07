/**
 * CRITICAL: withdrawal escrow must never exceed available points under
 * parallel creation, and same-key retries must replay the original response.
 *
 * Live test - requires the API running locally + lab seed.
 * Run (PowerShell): $env:LAB_CONCURRENCY='1'; npm run lab:concurrency
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'
import dotenv from 'dotenv'

const RUN = process.env.LAB_CONCURRENCY === '1'
const envBase = process.env.LAB_BASE_URL || ''
const BASE = /^https?:\/\//.test(envBase) ? envBase : 'http://localhost:3000'
const GROSS = 100_000n // minimum withdrawal

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type Result = {
  status: number
  body: { withdrawalId?: string; code?: string; [k: string]: unknown } | null
}

let token = ''
let userId = ''
let walletId = ''
let paymentMethodId = ''

async function withdraw(idempotencyKey: string): Promise<Result> {
  const res = await fetch(`${BASE}/api/v1/withdrawal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      grossPoints: GROSS.toString(),
      paymentMethodId,
      idempotencyKey,
    }),
  })
  const body = (await res.json().catch(() => null)) as Result['body']
  return { status: res.status, body }
}

/** Reset: point balance to target, escrow to 0, cancel leftover open withdrawals. */
async function resetPoints(target: bigint): Promise<void> {
  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId, currencyType: 'POINT' } },
    create: { userId, currencyType: 'POINT' },
    update: { unconfirmedPoints: 0n },
  })
  walletId = wallet.id
  await prisma.wallet.update({ where: { id: wallet.id }, data: { unconfirmedPoints: 0n } })
  const last = await prisma.pointLedgerEntry.findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  const current = last?.balanceAfter ?? 0n
  const delta = target - current
  if (delta !== 0n) {
    await prisma.pointLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: delta > 0n ? 'CREDIT' : 'DEBIT',
        txType: 'ADJUSTMENT',
        amount: delta > 0n ? delta : -delta,
        balanceAfter: target,
        description: 'lab withdrawal funding',
        idempotencyKey: `lab-wd-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(
    `wallet:points:${userId}`,
    `wallet:points:unconfirmed:${userId}`,
    `ratelimit:withdrawal:create:${userId}`,
  )
}

describe.skipIf(!RUN)('escrow cap: POST /api/v1/withdrawal', () => {
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

    const existing = await prisma.userPaymentMethod.findFirst({
      where: { userId, methodType: 'EPAY' },
    })
    paymentMethodId =
      existing?.id ??
      (
        await prisma.userPaymentMethod.create({
          data: { userId, methodType: 'EPAY', epayEmail: 'lab-user-1@test.local' },
        })
      ).id
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('4 parallel withdrawals with 3x funding: exactly 3 accepted, 1 INSUFFICIENT_POINTS, no 5xx', async () => {
    await resetPoints(GROSS * 3n)
    const startedAt = new Date()

    // Rate limit is 3/min - fire 3 in parallel, clear the window, then 1 more.
    const first3 = await Promise.all(
      Array.from({ length: 3 }, () => withdraw(`conc-${crypto.randomUUID()}`)),
    )
    await redis.del(`ratelimit:withdrawal:create:${userId}`)
    const fourth = await withdraw(`conc-${crypto.randomUUID()}`)
    const results = [...first3, fourth]

    const ok = results.filter((r) => r.status === 201)
    const insufficient = results.filter(
      (r) => r.status === 400 && r.body?.code === 'INSUFFICIENT_POINTS',
    )
    const other = results.filter((r) => r.status !== 201 && r.status !== 400)

    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)
    expect(ok).toHaveLength(3)
    expect(insufficient).toHaveLength(1)

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } })
    expect(wallet?.unconfirmedPoints).toBe(GROSS * 3n)

    const rows = await prisma.withdrawal.count({
      where: { userId, requestedAt: { gte: startedAt } },
    })
    expect(rows).toBe(3)
  }, 120_000)

  it('same-key retry replays the original response; parallel duplicate never double-escrows', async () => {
    await resetPoints(GROSS * 3n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([withdraw(key), withdraw(key)])
    const statuses = [a.status, b.status].sort()
    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])

    await redis.del(`ratelimit:withdrawal:create:${userId}`)
    const retry = await withdraw(key)
    expect(retry.status).toBe(201)
    const winner = a.status === 201 ? a : b
    expect(retry.body).toEqual(winner.body)

    const rows = await prisma.withdrawal.count({
      where: { userId, requestedAt: { gte: startedAt } },
    })
    expect(rows).toBe(1)

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } })
    expect(wallet?.unconfirmedPoints).toBe(GROSS)
  }, 60_000)
})
