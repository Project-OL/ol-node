/**
 * CRITICAL: concurrent gift sends must never double-spend or drive coin balance negative,
 * and retries with the same idempotencyKey must not double-process.
 *
 * Live test - requires the API running locally plus seeded lab users
 * (npm run lab:seed && npx tsx lab/fixtures/phase1-social-seed.ts).
 *
 * Run (PowerShell): $env:LAB_CONCURRENCY='1'; npm run lab:concurrency
 * Skipped unless LAB_CONCURRENCY=1 so the default vitest suite stays hermetic.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import * as fs from 'fs'
import * as path from 'path'
import crypto from 'crypto'
import dotenv from 'dotenv'

const RUN = process.env.LAB_CONCURRENCY === '1'
// Vitest mirrors Vite's built-in BASE_URL ('/') into process.env - only accept real URLs.
const envBase = process.env.LAB_BASE_URL || process.env.BASE_URL || ''
const BASE = /^https?:\/\//.test(envBase) ? envBase : 'http://localhost:3000'
const GIFT_NAME = 'Lab Concurrency Gift'
const GIFT_COST = 1000n
/** 60% host share (hostPointsFromGift) - keep in sync with src/config/host-revenue-shares. */
const POINTS_PER_GIFT = 600n

// tests/setup.ts injects placeholder DATABASE_URL/REDIS_URL when unset; this live
// test must talk to the real local stack, so read .env directly.
const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type SendResult = {
  status: number
  body: {
    transactionId?: string
    code?: string
    senderCoinsRemaining?: number
    [k: string]: unknown
  } | null
}

let token = ''
let senderId = ''
let receiverId = ''
let giftId = ''
let senderWalletId = ''
let receiverWalletId = ''

async function sendGift(idempotencyKey?: string): Promise<SendResult> {
  const res = await fetch(`${BASE}/api/v1/gifts/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      receiverUserId: receiverId,
      giftId,
      context: 'direct',
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  })
  const body = (await res.json().catch(() => null)) as SendResult['body']
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
        description: 'lab concurrency funding',
        idempotencyKey: `lab-conc-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${userId}`)
  await redis.del(`rl:gift:send:${userId}`)
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

describe.skipIf(!RUN)('double-spend: POST /api/v1/gifts/send', () => {
  beforeAll(async () => {
    await redis.connect()
    // repeated lab runs trip the per-identifier login rate limit - clear it first
    {
      const rlKeys = await redis.keys('ratelimit:login:*')
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
    senderId = loginBody.userId

    const receiverAuth = await prisma.authIdentifier.findFirst({
      where: { provider: 'email', identifier: 'lab-social-1@test.local' },
    })
    if (!receiverAuth) throw new Error('run npx tsx lab/fixtures/phase1-social-seed.ts first')
    receiverId = receiverAuth.userId

    const existingGift = await prisma.gift.findFirst({ where: { name: GIFT_NAME } })
    giftId =
      existingGift?.id ??
      (
        await prisma.gift.create({
          data: {
            name: GIFT_NAME,
            coinCost: Number(GIFT_COST),
            displayImageUrl: 'https://example.com/lab-gift.png',
            isActive: true,
          },
        })
      ).id

    const receiverWallet = await prisma.wallet.upsert({
      where: { userId_currencyType: { userId: receiverId, currencyType: 'POINT' } },
      create: { userId: receiverId, currencyType: 'POINT' },
      update: {},
    })
    receiverWalletId = receiverWallet.id
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('exactly K of N parallel sends succeed with K-gift funding; balance never negative; no 5xx', async () => {
    const K = 5
    const N = 12
    senderWalletId = await setCoinBalance(senderId, GIFT_COST * BigInt(K))
    const startedAt = new Date()

    const results = await Promise.all(Array.from({ length: N }, () => sendGift()))

    const ok = results.filter((r) => r.status === 201)
    const insufficient = results.filter(
      (r) => r.status === 402 && r.body?.code === 'INSUFFICIENT_COINS',
    )
    const other = results.filter((r) => r.status !== 201 && r.status !== 402)

    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)
    expect(ok).toHaveLength(K)
    expect(insufficient).toHaveLength(N - K)

    // Ledger: exactly K debits in this window, chain never negative, final balance 0.
    const debits = await prisma.coinLedgerEntry.findMany({
      where: {
        walletId: senderWalletId,
        txType: 'GIFT_SEND',
        createdAt: { gte: startedAt },
      },
      orderBy: { createdAt: 'asc' },
    })
    expect(debits).toHaveLength(K)
    for (const d of debits) {
      expect(d.balanceAfter >= 0n).toBe(true)
    }
    expect(await coinBalance(senderWalletId)).toBe(0n)

    // Receiver: exactly K credits of the 60% share.
    const credits = await prisma.pointLedgerEntry.findMany({
      where: {
        walletId: receiverWalletId,
        txType: 'GIFT_RECEIVE',
        counterpartyId: senderId,
        createdAt: { gte: startedAt },
      },
    })
    expect(credits).toHaveLength(K)
    for (const c of credits) {
      expect(c.amount).toBe(POINTS_PER_GIFT)
    }
  }, 120_000)

  it('sequential retry with the same idempotencyKey replays the original result (single debit)', async () => {
    await setCoinBalance(senderId, GIFT_COST * 3n)
    const startedAt = new Date()
    const key = crypto.randomUUID()

    const first = await sendGift(key)
    expect(first.status).toBe(201)
    expect(first.body?.transactionId).toBeTruthy()

    const second = await sendGift(key)
    expect(second.status).toBe(201)
    expect(second.body?.transactionId).toBe(first.body?.transactionId)
    expect(second.body).toEqual(first.body)

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: senderWalletId, txType: 'GIFT_SEND', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(senderWalletId)).toBe(GIFT_COST * 2n)
  }, 60_000)

  it('parallel duplicate idempotencyKey: exactly one debit; loser replays or gets IDEM_CONFLICT', async () => {
    await setCoinBalance(senderId, GIFT_COST * 2n)
    const startedAt = new Date()
    const key = crypto.randomUUID()

    const [a, b] = await Promise.all([sendGift(key), sendGift(key)])
    const statuses = [a.status, b.status].sort()

    // One request must win with 201; the other either replays the winner's
    // response (201, same transactionId) or reports the in-flight conflict (409).
    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])
    if (a.status === 201 && b.status === 201) {
      expect(a.body?.transactionId).toBe(b.body?.transactionId)
    }

    const debits = await prisma.coinLedgerEntry.count({
      where: { walletId: senderWalletId, txType: 'GIFT_SEND', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await coinBalance(senderWalletId)).toBe(GIFT_COST)
  }, 60_000)
})
