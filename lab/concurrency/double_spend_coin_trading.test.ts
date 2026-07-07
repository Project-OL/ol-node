/**
 * CRITICAL: coin-trading exchange and transfer must never double-process under
 * parallel load or retries (exchange previously minted a fresh refId per
 * request; transfer 500'd on same-key retry via the unique constraint).
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
import bcrypt from 'bcrypt'
import dotenv from 'dotenv'

const RUN = process.env.LAB_CONCURRENCY === '1'
const envBase = process.env.LAB_BASE_URL || ''
const BASE = /^https?:\/\//.test(envBase) ? envBase : 'http://localhost:3000'
const PIN = '135790'
const EXCHANGE_POINTS = 10_000n // one step = 1 USD equivalent
const TRANSFER_COINS = 1_000n // multiple of the 100-coin step

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type Result = { status: number; body: Record<string, unknown> | null }

let token = ''
let userId = ''
let recipientId = ''
let recipientPublicId = ''

async function post(pathname: string, body: Record<string, unknown>): Promise<Result> {
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

async function setWalletBalance(
  ownerId: string,
  currencyType: 'COIN' | 'POINT' | 'TRADING_COIN',
  target: bigint,
): Promise<string> {
  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: ownerId, currencyType } },
    create: { userId: ownerId, currencyType },
    update: {},
  })
  const table = currencyType === 'POINT' ? prisma.pointLedgerEntry : prisma.coinLedgerEntry
  const last = await (table as typeof prisma.coinLedgerEntry).findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  const current = last?.balanceAfter ?? 0n
  const delta = target - current
  if (delta !== 0n) {
    await (table as typeof prisma.coinLedgerEntry).create({
      data: {
        walletId: wallet.id,
        direction: delta > 0n ? 'CREDIT' : 'DEBIT',
        txType: 'ADJUSTMENT',
        amount: delta > 0n ? delta : -delta,
        balanceAfter: target,
        description: 'lab ct concurrency funding',
        idempotencyKey: `lab-ct-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${ownerId}`, `wallet:points:${ownerId}`, `ct:balance:${ownerId}`)
  await redis.del(
    `ratelimit:ct:exchange:${ownerId}`,
    `ratelimit:ct:transfer:${ownerId}`,
    `wallet:points:unconfirmed:${ownerId}`,
  )
  return wallet.id
}

async function ledgerBalance(walletId: string, isPoint: boolean): Promise<bigint> {
  const table = isPoint ? prisma.pointLedgerEntry : prisma.coinLedgerEntry
  const last = await (table as typeof prisma.coinLedgerEntry).findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

describe.skipIf(!RUN)('double-spend: coin-trading exchange + transfer', () => {
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

    // Security PIN required by /exchange.
    const pinHash = await bcrypt.hash(PIN, 12)
    await prisma.securityPassword.upsert({
      where: { userId },
      create: { userId, passwordHash: pinHash, failedAttempts: 0, lockedUntil: null },
      update: { passwordHash: pinHash, failedAttempts: 0, lockedUntil: null },
    })

    const recipientAuth = await prisma.authIdentifier.findFirst({
      where: { provider: 'email', identifier: 'lab-social-3@test.local' },
    })
    if (!recipientAuth) throw new Error('run npx tsx lab/fixtures/phase1-social-seed.ts first')
    recipientId = recipientAuth.userId
    const recipient = await prisma.user.findUnique({ where: { id: recipientId } })
    recipientPublicId = recipient!.publicId.toString()
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    // Transfer tests flip the lab user to agent; restore.
    await prisma.user
      .update({ where: { id: userId }, data: { isAgent: false } })
      .catch(() => undefined)
    await prisma.$disconnect()
    await redis.quit()
  })

  it('exchange: 3 parallel with distinct keys all settle exactly once each; no 5xx', async () => {
    await prisma.user.update({ where: { id: userId }, data: { isAgent: false } })
    const pointWalletId = await setWalletBalance(userId, 'POINT', EXCHANGE_POINTS * 3n)
    const startedAt = new Date()

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        post('/api/v1/coin-trading/exchange', {
          pointsToExchange: EXCHANGE_POINTS.toString(),
          idempotencyKey: `conc-${crypto.randomUUID()}`,
        }),
      ),
    )
    const other = results.filter((r) => r.status !== 200)
    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)

    const debits = await prisma.pointLedgerEntry.count({
      where: { walletId: pointWalletId, txType: 'TRANSFER_OUT', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(3)
    expect(await ledgerBalance(pointWalletId, true)).toBe(0n)
  }, 120_000)

  it('exchange: same-key retry replays the original result (single debit)', async () => {
    const pointWalletId = await setWalletBalance(userId, 'POINT', EXCHANGE_POINTS * 3n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const first = await post('/api/v1/coin-trading/exchange', {
      pointsToExchange: EXCHANGE_POINTS.toString(),
      idempotencyKey: key,
    })
    expect(first.status).toBe(200)
    const second = await post('/api/v1/coin-trading/exchange', {
      pointsToExchange: EXCHANGE_POINTS.toString(),
      idempotencyKey: key,
    })
    expect(second.status).toBe(200)
    expect(second.body).toEqual(first.body)

    const debits = await prisma.pointLedgerEntry.count({
      where: { walletId: pointWalletId, txType: 'TRANSFER_OUT', createdAt: { gte: startedAt } },
    })
    expect(debits).toBe(1)
    expect(await ledgerBalance(pointWalletId, true)).toBe(EXCHANGE_POINTS * 2n)
  }, 60_000)

  it('transfer: parallel + retried same-key transfers move coins exactly once per key', async () => {
    await prisma.user.update({ where: { id: userId }, data: { isAgent: true } })
    const tradingWalletId = await setWalletBalance(userId, 'TRADING_COIN', TRANSFER_COINS * 4n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`
    const body = {
      recipientPublicId,
      tradingCoins: TRANSFER_COINS.toString(),
      idempotencyKey: key,
    }

    // Parallel duplicate pair, then a sequential retry of the same key.
    const [a, b] = await Promise.all([
      post('/api/v1/coin-trading/transfer', body),
      post('/api/v1/coin-trading/transfer', body),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses[0] === 201).toBe(true)
    expect([201, 409]).toContain(statuses[1])

    const retry = await post('/api/v1/coin-trading/transfer', body)
    expect(retry.status).toBe(201)

    const transfers = await prisma.coinTradingTransfer.count({
      where: { idempotencyKey: `trading-transfer:${userId}:${key}` },
    })
    expect(transfers).toBe(1)

    const debits = await prisma.coinLedgerEntry.count({
      where: {
        walletId: tradingWalletId,
        txType: 'TRADING_TRANSFER_OUT',
        createdAt: { gte: startedAt },
      },
    })
    expect(debits).toBe(1)
    expect(await ledgerBalance(tradingWalletId, false)).toBe(TRANSFER_COINS * 3n)

    // A second distinct key must still work (no over-broad dedupe).
    const fresh = await post('/api/v1/coin-trading/transfer', {
      ...body,
      idempotencyKey: `conc-${crypto.randomUUID()}`,
    })
    expect(fresh.status).toBe(201)
    expect(await ledgerBalance(tradingWalletId, false)).toBe(TRANSFER_COINS * 2n)
  }, 120_000)
})
