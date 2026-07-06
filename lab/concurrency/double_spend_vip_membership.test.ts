/**
 * CRITICAL: VIP membership stacking math must hold under parallel purchases
 * (expiresAt = base + N * periodDays, N debits), and retries with the same
 * idempotencyKey must replay the original result instead of buying again.
 *
 * Live test - requires the API running locally plus seeded lab user
 * (npm run lab:seed). Run (PowerShell): $env:LAB_CONCURRENCY='1'; npm run lab:concurrency
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
/** Keep in sync with src/services/vip-membership.helpers.ts */
const DIAMOND_COST = 1_000_000n
const DIAMOND_PERIOD_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type BuyResult = {
  status: number
  body: { tier?: string; coinsPaid?: string; expiresAt?: string; code?: string } | null
}

let token = ''
let userId = ''
let walletId = ''

async function buy(idempotencyKey: string): Promise<BuyResult> {
  const res = await fetch(`${BASE}/api/v1/vip-membership/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ tier: 'DIAMOND', idempotencyKey }),
  })
  const body = (await res.json().catch(() => null)) as BuyResult['body']
  return { status: res.status, body }
}

async function resetVipState() {
  await prisma.user.update({
    where: { id: userId },
    data: {
      vipSubscriptionExpiresAt: null,
      vipSubscriptionStartAt: null,
      vipSubscriptionActive: false,
    },
  })
  await redis.del(`vipm:active:${userId}`)
  await redis.del(`ratelimit:vip-membership:purchase:${userId}`)
}

async function setCoinBalance(target: bigint): Promise<string> {
  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId, currencyType: 'COIN' } },
    create: { userId, currencyType: 'COIN' },
    update: {},
  })
  const last = await prisma.coinLedgerEntry.findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  const current = last?.balanceAfter ?? 0n
  const delta = target - current
  if (delta !== 0n) {
    await prisma.coinLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: delta > 0n ? 'CREDIT' : 'DEBIT',
        txType: 'ADJUSTMENT',
        amount: delta > 0n ? delta : -delta,
        balanceAfter: target,
        description: 'lab vipm concurrency funding',
        idempotencyKey: `lab-vipm-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${userId}`)
  return wallet.id
}

async function coinBalance(): Promise<bigint> {
  const last = await prisma.coinLedgerEntry.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

describe.skipIf(!RUN)('stacking: POST /api/v1/vip-membership/purchase', () => {
  beforeAll(async () => {
    await redis.connect()
    const rlKeys = await redis
      .keys('ratelimit:login:*')
      .then(async (a) => a.concat(await redis.keys('ratelimit:auth:*')))
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
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await resetVipState().catch(() => undefined)
    await prisma.$disconnect()
    await redis.quit()
  })

  it('3 parallel purchases stack exactly 3 periods: 3 debits, expiresAt = now + 90d, no 5xx', async () => {
    const N = 3
    await resetVipState()
    walletId = await setCoinBalance(DIAMOND_COST * BigInt(N))
    const startedAt = new Date()

    const results = await Promise.all(
      Array.from({ length: N }, () => buy(`conc-${crypto.randomUUID()}`)),
    )

    const other = results.filter((r) => r.status !== 201)
    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId, txType: 'VIP_MEMBERSHIP_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(N)
    expect(await coinBalance()).toBe(0n)

    // The money-math core: every paid period must be reflected in the expiry.
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { vipSubscriptionExpiresAt: true, vipSubscriptionActive: true },
    })
    expect(u?.vipSubscriptionActive).toBe(true)
    const expected = startedAt.getTime() + N * DIAMOND_PERIOD_DAYS * DAY_MS
    const actual = u!.vipSubscriptionExpiresAt!.getTime()
    // allow the seconds the requests took to run
    expect(Math.abs(actual - expected)).toBeLessThan(60_000)

    const purchases = await prisma.vipMembershipPurchase.count({
      where: { userId, createdAt: { gte: startedAt } },
    })
    expect(purchases).toBe(N)
  }, 120_000)

  it('sequential retry with the same idempotencyKey replays the original result (single purchase)', async () => {
    await resetVipState()
    walletId = await setCoinBalance(DIAMOND_COST * 3n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const first = await buy(key)
    expect(first.status).toBe(201)
    expect(first.body?.expiresAt).toBeTruthy()

    const second = await buy(key)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId, txType: 'VIP_MEMBERSHIP_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance()).toBe(DIAMOND_COST * 2n)
  }, 60_000)

  it('parallel duplicate idempotencyKey: exactly one purchase; both callers converge on it', async () => {
    await resetVipState()
    walletId = await setCoinBalance(DIAMOND_COST * 2n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([buy(key), buy(key)])
    const statuses = [a.status, b.status].sort()

    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])
    if (a.status === 201 && b.status === 201) {
      expect(a.body).toEqual(b.body)
    }

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId, txType: 'VIP_MEMBERSHIP_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance()).toBe(DIAMOND_COST)
  }, 60_000)
})
