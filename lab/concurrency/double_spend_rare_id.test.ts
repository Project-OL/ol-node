/**
 * CRITICAL: a rare ID is unique inventory - N parallel purchases of the same ID
 * must sell it exactly once (no 5xx for the losers), and retries with the same
 * idempotencyKey must replay the original result (not 404/500 after a settled buy).
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
const PRICE = 1000n

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
  body: { publicId?: string; code?: string; [k: string]: unknown } | null
}

let token = ''
let buyerId = ''
let buyerWalletId = ''
let rareSeq = 0

async function buy(publicId: bigint, idempotencyKey: string): Promise<BuyResult> {
  const res = await fetch(`${BASE}/api/v1/store/rare-ids/purchase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ publicId: publicId.toString(), idempotencyKey }),
  })
  const body = (await res.json().catch(() => null)) as BuyResult['body']
  return { status: res.status, body }
}

async function createRareId(): Promise<bigint> {
  const publicId =
    BigInt(9_800_000_000) + BigInt(Date.now() % 1_000_000_000) * 100n + BigInt(rareSeq++)
  await prisma.vipPublicId.create({
    data: { publicId, isAvailable: true, priceCredits: Number(PRICE), rarityScore: 10 },
  })
  return publicId
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
        description: 'lab rareid concurrency funding',
        idempotencyKey: `lab-rareid-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${userId}`)
  await redis.del(`ratelimit:store:rare-id:${userId}`)
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

describe.skipIf(!RUN)('unique inventory: POST /api/v1/store/rare-ids/purchase', () => {
  beforeAll(async () => {
    await redis.connect()
    const rlKeys = await redis.keys('ratelimit:login:*')
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
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('one rare ID, 6 parallel buyers-worth of requests: sold exactly once, losers get 4xx, no 5xx', async () => {
    const N = 6
    buyerWalletId = await setCoinBalance(buyerId, PRICE * BigInt(N))
    const publicId = await createRareId()
    const startedAt = new Date()

    const results = await Promise.all(
      Array.from({ length: N }, () => buy(publicId, `conc-${crypto.randomUUID()}`)),
    )

    const ok = results.filter((r) => r.status === 201)
    const gone = results.filter(
      (r) =>
        (r.status === 404 || r.status === 409) &&
        (r.body?.code === 'RARE_ID_NOT_AVAILABLE' || r.body?.code === 'RARE_ID_ALREADY_OWNED'),
    )
    const other = results.filter((r) => ![...ok, ...gone].includes(r))

    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)
    expect(ok).toHaveLength(1)
    expect(gone).toHaveLength(N - 1)

    // Inventory sold exactly once, one debit, one assignment.
    const rare = await prisma.vipPublicId.findUnique({ where: { publicId } })
    expect(rare?.isAvailable).toBe(false)
    expect(rare?.currentOwnerId).toBe(buyerId)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: buyerWalletId, txType: 'VIP_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(buyerWalletId)).toBe(PRICE * BigInt(N - 1))

    const assignments = await prisma.userVipAssignment.count({
      where: { userId: buyerId, publicId },
    })
    expect(assignments).toBe(1)
  }, 120_000)

  it('sequential retry with the same idempotencyKey replays the original result (single debit)', async () => {
    await setCoinBalance(buyerId, PRICE * 3n)
    const publicId = await createRareId()
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const first = await buy(publicId, key)
    expect(first.status).toBe(201)
    expect(first.body?.publicId).toBe(publicId.toString())

    const second = await buy(publicId, key)
    expect(second.status).toBe(201)
    expect(second.body).toEqual(first.body)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: buyerWalletId, txType: 'VIP_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(buyerWalletId)).toBe(PRICE * 2n)
  }, 60_000)

  it('parallel duplicate idempotencyKey: exactly one debit; loser replays or gets IDEM_CONFLICT', async () => {
    await setCoinBalance(buyerId, PRICE * 2n)
    const publicId = await createRareId()
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([buy(publicId, key), buy(publicId, key)])
    const statuses = [a.status, b.status].sort()

    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])
    if (a.status === 201 && b.status === 201) {
      expect(a.body).toEqual(b.body)
    }

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: buyerWalletId, txType: 'VIP_PURCHASE', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(buyerWalletId)).toBe(PRICE)
  }, 60_000)
})
