/**
 * CRITICAL: concurrent store purchases must never double-spend, and retries with
 * the same idempotencyKey must replay the original result (never 500 / double-buy).
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
const ITEM_NAME = 'Lab Concurrency Store Item'
const ITEM_COST = 1000n

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type PurchaseResult = {
  status: number
  body: { userStoreItemId?: string; code?: string; [k: string]: unknown } | null
}

let token = ''
let buyerId = ''
let storeItemId = ''
let buyerWalletId = ''

async function purchase(idempotencyKey: string): Promise<PurchaseResult> {
  const res = await fetch(`${BASE}/api/v1/store/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ storeItemId, idempotencyKey }),
  })
  const body = (await res.json().catch(() => null)) as PurchaseResult['body']
  return { status: res.status, body }
}

async function setCoinBalance(userId: string, target: bigint): Promise<string> {
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
        description: 'lab store concurrency funding',
        idempotencyKey: `lab-store-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${userId}`)
  await redis.del(`ratelimit:store:purchase:${userId}`)
  return wallet.id
}

async function coinBalance(walletId: string): Promise<bigint> {
  const last = await prisma.coinLedgerEntry.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

describe.skipIf(!RUN)('double-spend: POST /api/v1/store/purchase', () => {
  beforeAll(async () => {
    await redis.connect()
    // repeated lab runs trip the per-identifier login rate limit - clear it first
    {
      const rlKeys = await redis
        .keys('ratelimit:login:*')
        .then(async (a) => a.concat(await redis.keys('ratelimit:auth:*')))
      if (rlKeys.length > 0) await redis.del(...rlKeys)
    }

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

    const existing = await prisma.storeItem.findFirst({ where: { name: ITEM_NAME } })
    storeItemId =
      existing?.id ??
      (
        await prisma.storeItem.create({
          data: {
            name: ITEM_NAME,
            category: 'RIDE',
            coinCost: Number(ITEM_COST),
            validityDays: 15,
            displayImageUrl: 'https://example.com/lab-store-item.png',
            isActive: true,
          },
        })
      ).id
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('exactly K of N parallel purchases succeed with K-item funding; no 5xx', async () => {
    const K = 3
    const N = 8 // stays under the 10/min purchase rate limit
    buyerWalletId = await setCoinBalance(buyerId, ITEM_COST * BigInt(K))
    const startedAt = new Date()

    const results = await Promise.all(
      Array.from({ length: N }, () => purchase(`conc-${crypto.randomUUID()}`)),
    )

    const ok = results.filter((r) => r.status === 201)
    const insufficient = results.filter(
      (r) => r.status === 402 && r.body?.code === 'INSUFFICIENT_COINS',
    )
    const other = results.filter((r) => r.status !== 201 && r.status !== 402)

    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)
    expect(ok).toHaveLength(K)
    expect(insufficient).toHaveLength(N - K)

    const debits = await prisma.coinLedgerEntry.findMany({
      where: {
        walletId: buyerWalletId,
        txType: 'STORE_ITEM_PURCHASE',
        createdAt: { gte: startedAt },
      },
      orderBy: { createdAt: 'asc' },
    })
    expect(debits).toHaveLength(K)
    for (const d of debits) {
      expect(d.balanceAfter >= 0n).toBe(true)
    }
    expect(await coinBalance(buyerWalletId)).toBe(0n)

    const rows = await prisma.userStoreItem.count({
      where: { userId: buyerId, storeItemId, createdAt: { gte: startedAt } },
    })
    expect(rows).toBe(K)
  }, 120_000)

  it('sequential retry with the same idempotencyKey replays the original result (single buy)', async () => {
    await setCoinBalance(buyerId, ITEM_COST * 3n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const first = await purchase(key)
    expect(first.status).toBe(201)
    expect(first.body?.userStoreItemId).toBeTruthy()

    const second = await purchase(key)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const debits = await prisma.coinLedgerEntry.count({
      where: {
        walletId: buyerWalletId,
        txType: 'STORE_ITEM_PURCHASE',
        createdAt: { gte: startedAt },
      },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(buyerWalletId)).toBe(ITEM_COST * 2n)
  }, 60_000)

  it('parallel duplicate idempotencyKey: exactly one buy; loser replays or gets IDEM_CONFLICT', async () => {
    await setCoinBalance(buyerId, ITEM_COST * 2n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([purchase(key), purchase(key)])
    const statuses = [a.status, b.status].sort()

    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])
    if (a.status === 201 && b.status === 201) {
      expect(a.body?.userStoreItemId).toBe(b.body?.userStoreItemId)
    }

    const debits = await prisma.coinLedgerEntry.count({
      where: {
        walletId: buyerWalletId,
        txType: 'STORE_ITEM_PURCHASE',
        createdAt: { gte: startedAt },
      },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(buyerWalletId)).toBe(ITEM_COST)
  }, 60_000)
})
