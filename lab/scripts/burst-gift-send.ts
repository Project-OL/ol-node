/**
 * Money-path burst load test: POST /gifts/send under sustained parallel load,
 * exercising the Read Committed + FOR UPDATE wallet path directly (not reads).
 *
 * Fires WAVES x CONC parallel sends against one funded sender wallet, then
 * verifies the ledger settled exactly: every 201 = one debit, chain
 * non-negative, final balance exact, receiver credits exact.
 *
 * Requires the API running + lab seed + phase1 social seed.
 * Usage: npx tsx lab/scripts/burst-gift-send.ts [waves] [concurrency]
 */
import { PrismaClient } from '@prisma/client'
import { Redis } from 'ioredis'
import crypto from 'crypto'

const BASE = process.env.LAB_BASE_URL || 'http://localhost:3000'
const WAVES = Number(process.argv[2] ?? '3')
const CONC = Number(process.argv[3] ?? '8')
const GIFT_NAME = 'Lab Probe Gift'
const GIFT_COST = 1000n
const POINTS_PER_GIFT = 600n

const prisma = new PrismaClient()
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379')

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!
}

async function main() {
  const rl = (await redis.keys('ratelimit:login:*')).concat(await redis.keys('ratelimit:auth:*'))
  if (rl.length) await redis.del(...rl)

  const loginRes = await fetch(`${BASE}/api/v1/auth/login/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'email',
      identifier: process.env.LAB_EMAIL || 'lab-user-1@test.local',
      password: process.env.LAB_PASSWORD || 'LabPassword123!',
      deviceId: 'lab-burst-device-0001',
      deviceName: 'lab-burst',
    }),
  })
  if (loginRes.status !== 200) throw new Error(`login failed ${loginRes.status}`)
  const { accessToken: token, userId: senderId } = (await loginRes.json()) as {
    accessToken: string
    userId: string
  }

  const receiverAuth = await prisma.authIdentifier.findFirst({
    where: { provider: 'email', identifier: 'lab-social-1@test.local' },
  })
  if (!receiverAuth) throw new Error('run npx tsx lab/fixtures/phase1-social-seed.ts first')
  const receiverId = receiverAuth.userId

  const gift =
    (await prisma.gift.findFirst({ where: { name: GIFT_NAME } })) ??
    (await prisma.gift.create({
      data: {
        name: GIFT_NAME,
        coinCost: Number(GIFT_COST),
        displayImageUrl: 'https://example.com/lab-gift.png',
        isActive: true,
      },
    }))

  const totalSends = WAVES * CONC
  // Fund exactly; every send must succeed.
  const wallet = await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: senderId, currencyType: 'COIN' } },
    create: { userId: senderId, currencyType: 'COIN' },
    update: {},
  })
  const last = await prisma.coinLedgerEntry.findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  const target = GIFT_COST * BigInt(totalSends)
  const current = last?.balanceAfter ?? 0n
  if (current !== target) {
    await prisma.coinLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: target > current ? 'CREDIT' : 'DEBIT',
        txType: 'ADJUSTMENT',
        amount: target > current ? target - current : current - target,
        balanceAfter: target,
        description: 'lab burst funding',
        idempotencyKey: `lab-burst-fund-${crypto.randomUUID()}`,
      },
    })
  }
  await redis.del(`wallet:coins:${senderId}`)

  const latencies: number[] = []
  const statuses = new Map<number, number>()
  const startedAt = new Date()
  const t0 = Date.now()

  for (let w = 0; w < WAVES; w++) {
    // Gift-send rate limit is 30/min per user - reset between waves.
    await redis.del(`rl:gift:send:${senderId}`)
    await Promise.all(
      Array.from({ length: CONC }, async () => {
        const s = Date.now()
        const res = await fetch(`${BASE}/api/v1/gifts/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({
            receiverUserId: receiverId,
            giftId: gift.id,
            context: 'direct',
            idempotencyKey: crypto.randomUUID(),
          }),
        })
        await res.json().catch(() => null)
        latencies.push(Date.now() - s)
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1)
      }),
    )
  }
  const wallMs = Date.now() - t0

  // Settlement verification
  const debits = await prisma.coinLedgerEntry.findMany({
    where: { walletId: wallet.id, txType: 'GIFT_SEND', createdAt: { gte: startedAt } },
    orderBy: { createdAt: 'asc' },
    select: { amount: true, balanceAfter: true },
  })
  const finalBal = await prisma.coinLedgerEntry.findFirst({
    where: { walletId: wallet.id },
    orderBy: { createdAt: 'desc' },
    select: { balanceAfter: true },
  })
  const credits = await prisma.pointLedgerEntry.count({
    where: {
      wallet: { userId: receiverId, currencyType: 'POINT' },
      txType: 'GIFT_RECEIVE',
      counterpartyId: senderId,
      createdAt: { gte: startedAt },
      amount: POINTS_PER_GIFT,
    },
  })

  const ok = statuses.get(201) ?? 0
  const sorted = [...latencies].sort((a, b) => a - b)
  const chainOk = debits.every((d) => d.balanceAfter >= 0n)
  const settledOk =
    ok === totalSends &&
    debits.length === totalSends &&
    credits === totalSends &&
    (finalBal?.balanceAfter ?? -1n) === 0n &&
    chainOk

  console.log(
    JSON.stringify(
      {
        waves: WAVES,
        concurrency: CONC,
        totalSends,
        wallMs,
        throughputRps: Number(((totalSends * 1000) / wallMs).toFixed(1)),
        statuses: Object.fromEntries(statuses),
        latencyMs: {
          p50: pct(sorted, 50),
          p95: pct(sorted, 95),
          p99: pct(sorted, 99),
          max: sorted[sorted.length - 1],
        },
        settlement: {
          debits: debits.length,
          receiverCredits: credits,
          finalBalance: (finalBal?.balanceAfter ?? -1n).toString(),
          balanceChainNonNegative: chainOk,
          EXACT: settledOk,
        },
      },
      null,
      2,
    ),
  )
  await prisma.$disconnect()
  await redis.quit()
  if (!settledOk) process.exit(1)
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect().catch(() => undefined)
  await redis.quit().catch(() => undefined)
  process.exit(1)
})
