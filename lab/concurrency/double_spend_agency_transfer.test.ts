/**
 * CRITICAL: agent point transfers must move points exactly once per
 * idempotency key under parallel load and retries.
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
const POINTS = 100_000n // one step

const fileEnv = fs.existsSync(path.resolve('.env'))
  ? dotenv.parse(fs.readFileSync(path.resolve('.env')))
  : {}
const DATABASE_URL = fileEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
const REDIS_URL = fileEnv.REDIS_URL ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379'

const prisma = RUN
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : (null as unknown as PrismaClient)
const redis = RUN ? new Redis(REDIS_URL, { lazyConnect: true }) : (null as unknown as Redis)

type Result = { status: number; body: { transferId?: string; code?: string } | null }

let token = ''
let senderId = ''
let recipientId = ''
let recipientPublicId = ''
let senderWalletId = ''

async function transfer(idempotencyKey?: string): Promise<Result> {
  const res = await fetch(`${BASE}/api/v1/agency/transfer-points`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-security-password': PIN,
    },
    body: JSON.stringify({
      recipientAgentPublicId: recipientPublicId,
      points: POINTS.toString(),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  })
  const body = (await res.json().catch(() => null)) as Result['body']
  return { status: res.status, body }
}

async function setPointBalance(ownerId: string, target: bigint): Promise<string> {
  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: ownerId, currencyType: 'POINT' } },
    create: { userId: ownerId, currencyType: 'POINT' },
    update: { unconfirmedPoints: 0n },
  })
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
        description: 'lab agency transfer funding',
        idempotencyKey: `lab-agt-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(
    `wallet:points:${ownerId}`,
    `wallet:points:unconfirmed:${ownerId}`,
    `ratelimit:agency:point-transfer:${ownerId}`,
  )
  return wallet.id
}

async function pointBalance(walletId: string): Promise<bigint> {
  const last = await prisma.pointLedgerEntry.findFirst({
    where: { walletId },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  return last?.balanceAfter ?? 0n
}

describe.skipIf(!RUN)('double-spend: POST /api/v1/agency/commission/transfer-points', () => {
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
    senderId = loginBody.userId

    const pinHash = await bcrypt.hash(PIN, 12)
    await prisma.securityPassword.upsert({
      where: { userId: senderId },
      create: { userId: senderId, passwordHash: pinHash, failedAttempts: 0, lockedUntil: null },
      update: { passwordHash: pinHash, failedAttempts: 0, lockedUntil: null },
    })

    // Recipient must be an agent (agency row keyed by defaultPublicId).
    const recipientAuth = await prisma.authIdentifier.findFirst({
      where: { provider: 'email', identifier: 'lab-social-4@test.local' },
    })
    if (!recipientAuth) throw new Error('run npx tsx lab/fixtures/phase1-social-seed.ts first')
    recipientId = recipientAuth.userId
    const recipient = await prisma.user.findUnique({ where: { id: recipientId } })
    recipientPublicId = recipient!.publicId.toString()
    await prisma.agency.upsert({
      where: { userId: recipientId },
      create: {
        userId: recipientId,
        defaultPublicId: recipient!.publicId,
        displayName: 'Lab Concurrency Agency',
      },
      update: { pausedAt: null },
    })
  }, 60_000)

  afterAll(async () => {
    if (!RUN) return
    await prisma.$disconnect()
    await redis.quit()
  })

  it('3 parallel transfers with distinct keys: all 201, 3 debits, recipient credited exactly 3x', async () => {
    senderWalletId = await setPointBalance(senderId, POINTS * 3n)
    const recipientWalletId = await setPointBalance(recipientId, 0n)
    const startedAt = new Date()

    const results = await Promise.all(
      Array.from({ length: 3 }, () => transfer(`conc-${crypto.randomUUID()}`)),
    )
    const other = results.filter((r) => r.status !== 201)
    expect(other, `unexpected statuses: ${JSON.stringify(other)}`).toHaveLength(0)

    const debits = await prisma.pointLedgerEntry.count({
      where: {
        walletId: senderWalletId,
        txType: 'AGENT_POINT_TRANSFER',
        direction: 'DEBIT',
        createdAt: { gte: startedAt },
      },
    })
    expect(debits).toBe(3)
    expect(await pointBalance(senderWalletId)).toBe(0n)
    expect(await pointBalance(recipientWalletId)).toBe(POINTS * 3n)
  }, 120_000)

  it('same-key retry and parallel duplicate converge on one transfer', async () => {
    senderWalletId = await setPointBalance(senderId, POINTS * 2n)
    const startedAt = new Date()
    const key = `conc-${crypto.randomUUID()}`

    const [a, b] = await Promise.all([transfer(key), transfer(key)])
    expect([a.status, b.status].every((s) => s === 201)).toBe(true)
    expect(a.body?.transferId).toBe(b.body?.transferId)

    const retry = await transfer(key)
    expect(retry.status).toBe(201)
    expect(retry.body?.transferId).toBe(a.body?.transferId)

    const rows = await prisma.agentPointTransfer.count({
      where: { idempotencyKey: `agent-point-transfer:${senderId}:${key}` },
    })
    expect(rows).toBe(1)

    const debits = await prisma.pointLedgerEntry.count({
      where: {
        walletId: senderWalletId,
        txType: 'AGENT_POINT_TRANSFER',
        direction: 'DEBIT',
        createdAt: { gte: startedAt },
      },
    })
    expect(debits).toBe(1)
    expect(await pointBalance(senderWalletId)).toBe(POINTS)
  }, 60_000)
})
