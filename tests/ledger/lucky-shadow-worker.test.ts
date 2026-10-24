/**
 * F4 shadow worker DB checks (local Docker PG :5433).
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import {
  SHADOW_SETTLE_LAG_MS,
  shadowAuditIdempotencyKey,
} from '../../src/services/luckyWater/shadowWorker.constants'
import {
  fetchShadowGiftBatch,
  processShadowGiftRow,
  runShadowWorkerTick,
  shadowSettleLagMs,
} from '../../src/services/luckyWater/shadowWorker.service'

const rid = () => randomUUID().replace(/-/g, '').slice(0, 12)

async function makeUser() {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 80_000_000))
  return prisma.user.create({
    data: {
      username: `sh_${rid()}`,
      publicId,
      defaultPublicId: publicId,
    },
  })
}

async function makeLuckyGift(coinCost: number) {
  return prisma.gift.create({
    data: {
      name: `sh_gift_${rid()}`,
      coinCost,
      displayImageUrl: 'https://example.invalid/g.png',
      code: `sh_${rid()}`,
      isActive: true,
      isLucky: true,
    },
  })
}

async function insertGiftTx(params: {
  senderId: string
  giftId: string
  unitPrice: number
  quantity: number
  createdAt: Date
}) {
  const total = params.unitPrice * params.quantity
  const context = params.quantity > 1 ? 'LUCKY_COMBO' : 'LUCKY_SINGLE'
  return prisma.giftTransaction.create({
    data: {
      id: randomUUID(),
      senderUserId: params.senderId,
      receiverUserId: params.senderId,
      giftId: params.giftId,
      coinCost: total,
      quantity: params.quantity,
      pointsAwarded: 0,
      context,
      createdAt: params.createdAt,
    },
  })
}

describe('lucky shadow worker (F4)', () => {
  beforeAll(async () => {
    await prisma.luckyShadowCursor.deleteMany({})
    await prisma.luckyDrawAudit.deleteMany({ where: { mode: 'shadow' } })
    await prisma.luckyTierPoolShadow.deleteMany({})
    await prisma.luckyTierConfig.updateMany({ data: { mode: 'off' } })
  })

  afterAll(async () => {
    await prisma.luckyTierConfig.updateMany({ data: { mode: 'off' } })
    await prisma.luckyShadowCursor.deleteMany({})
    await prisma.$disconnect()
  })

  it('settle lag constant matches ledger timeout + 30s buffer', () => {
    expect(shadowSettleLagMs()).toBe(SHADOW_SETTLE_LAG_MS)
    expect(SHADOW_SETTLE_LAG_MS).toBe(45_000)
  })

  it('fetchShadowGiftBatch excludes rows newer than the settle window', async () => {
    await prisma.luckyTierConfig.updateMany({ where: { tierId: 'T100' }, data: { mode: 'shadow' } })
    const sender = await makeUser()
    const gift = await makeLuckyGift(100)
    const now = new Date()
    const tooFresh = new Date(now.getTime() - 10_000)
    const settled = new Date(now.getTime() - SHADOW_SETTLE_LAG_MS - 5_000)

    const freshTx = await insertGiftTx({
      senderId: sender.id,
      giftId: gift.id,
      unitPrice: 100,
      quantity: 1,
      createdAt: tooFresh,
    })
    const oldTx = await insertGiftTx({
      senderId: sender.id,
      giftId: gift.id,
      unitPrice: 100,
      quantity: 1,
      createdAt: settled,
    })

    const batch = await fetchShadowGiftBatch()
    const ids = batch.map((r) => r.id)
    expect(ids).toContain(oldTx.id)
    expect(ids).not.toContain(freshTx.id)
  })

  it('shadow draw is idempotent on audit key shadow:{giftTxId}', async () => {
    await prisma.luckyTierConfig.updateMany({ where: { tierId: 'T100' }, data: { mode: 'shadow' } })
    await prisma.luckyTierPoolShadow.deleteMany({ where: { tierId: 'T100' } })
    await prisma.luckyTierPool.deleteMany({ where: { tierId: 'T100' } })
    await prisma.luckyShadowCursor.deleteMany({})

    const sender = await makeUser()
    const gift = await makeLuckyGift(100)
    const createdAt = new Date(Date.now() - SHADOW_SETTLE_LAG_MS - 2_000)
    const tx = await insertGiftTx({
      senderId: sender.id,
      giftId: gift.id,
      unitPrice: 100,
      quantity: 1,
      createdAt,
    })

    const batch = await fetchShadowGiftBatch()
    const row = batch.find((r) => r.id === tx.id)
    expect(row).toBeTruthy()

    const first = await processShadowGiftRow(row!)
    expect(first).toBe('drawn')

    const auditKey = shadowAuditIdempotencyKey(tx.id)
    const audits = await prisma.luckyDrawAudit.findMany({ where: { idempotencyKey: auditKey } })
    expect(audits).toHaveLength(1)
    expect(audits[0]?.mode).toBe('shadow')
    expect(audits[0]?.engine).toBe('water_v1')

    const livePool = await prisma.luckyTierPool.findUnique({ where: { tierId: 'T100' } })
    expect(livePool).toBeNull()
    const shadowPool = await prisma.luckyTierPoolShadow.findUnique({ where: { tierId: 'T100' } })
    expect(shadowPool).toBeTruthy()

    const second = await processShadowGiftRow(row!)
    expect(second).toBe('noop')
    const auditsAfter = await prisma.luckyDrawAudit.findMany({ where: { idempotencyKey: auditKey } })
    expect(auditsAfter).toHaveLength(1)
  })

  it('runShadowWorkerTick no-ops when no tier is in shadow mode', async () => {
    await prisma.luckyTierConfig.updateMany({ data: { mode: 'off' } })
    const r = await runShadowWorkerTick()
    expect(r.processed).toBe(0)
  })
})
