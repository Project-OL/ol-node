/**
 * CRITICAL: guardian purchases must not 5xx under parallel load, and retries
 * with the same idempotencyKey must replay the original result (no re-charge,
 * no free extension).
 *
 * Live test - requires the API running locally + lab seed + phase1 social seed.
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
/** SILVER x 1 month; host share 75%. Keep in sync with guardian.service / host-revenue-shares. */
const PRICE = 150_000n
const HOST_POINTS = 112_500n

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type BuyResult = { status: number; body: Record<string, unknown> | null }

let token = ''
let buyerId = ''
let targetId = ''
let buyerWalletId = ''

async function buy(idempotencyKey?: string): Promise<BuyResult> {
  const res = await fetch(`${BASE}/api/v1/guardian`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      targetUserId: targetId,
      tier: 'SILVER',
      durationMonths: 1,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  })
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, body }
}

async function setCoinBalance(target: bigint): Promise<string> {
  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: buyerId, currencyType: 'COIN' } },
    create: { userId: buyerId, currencyType: 'COIN' },
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
        description: 'lab guardian concurrency funding',
        idempotencyKey: `lab-guard-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${buyerId}`)
  await redis.del(`ratelimit:guardian:purchase:${buyerId}`)
  return wallet.id
}

async function coinBalance(): Promise<bigint> {
  const last = await prisma.coinLedgerEntry.findFirst({
    where: { walletId: buyerWalletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

describe.skipIf(!RUN)('double-spend: POST /api/v1/guardian', () => {
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
    buyerId = loginBody.userId

    const targetAuth = await prisma.authIdentifier.findFirst({
      where: { provider: 'email', identifier: 'lab-social-2@test.local' },
    })
    if (!targetAuth) throw new Error('run npx tsx lab/fixtures/phase1-social-seed.ts first')
    targetId = targetAuth.userId
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('3 parallel purchases: all 201, 3 debits, 3 host credits of 75%, no 5xx', async () => {
    const N = 3
    buyerWalletId = await setCoinBalance(PRICE * BigInt(N))
    const startedAt = new Date()

    const results = await Promise.all(
      Array.from({ length: N }, () => buy(`conc-${crypto.randomUUID()}`)),
    )
    const other = results.filter((r) => r.status !== 201)
    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: buyerWalletId, txType: 'GUARDIAN_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(N)
    expect(await coinBalance()).toBe(0n)

    const credits = await prisma.pointLedgerEntry.findMany({
      where: {
        wallet: { userId: targetId, currencyType: 'POINT' },
        txType: 'GUARDIAN_PURCHASE',
        createdAt: { gte: startedAt },
      },
      select: { amount: true },
    })
    expect(credits).toHaveLength(N)
    for (const c of credits) expect(c.amount).toBe(HOST_POINTS)
  }, 120_000)

  it('sequential retry with the same idempotencyKey replays the original result (single charge)', async () => {
    buyerWalletId = await setCoinBalance(PRICE * 3n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const first = await buy(key)
    expect(first.status).toBe(201)
    const second = await buy(key)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: buyerWalletId, txType: 'GUARDIAN_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance()).toBe(PRICE * 2n)
  }, 60_000)

  it('parallel duplicate idempotencyKey: exactly one charge; loser replays or 409', async () => {
    buyerWalletId = await setCoinBalance(PRICE * 2n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([buy(key), buy(key)])
    const statuses = [a.status, b.status].sort()
    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])
    if (a.status === 201 && b.status === 201) expect(a.body).toEqual(b.body)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: buyerWalletId, txType: 'GUARDIAN_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance()).toBe(PRICE)
  }, 60_000)
})
