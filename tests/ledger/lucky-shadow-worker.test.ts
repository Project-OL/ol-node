/**
 * F4 shadow worker DB checks (local Docker PG :5433).
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import {
  LUCKY_SHADOW_CURSOR_ID,
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

/** Pin the shadow cursor so the next batch is only txs created after this anchor. */
async function anchorShadowCursor(before: Date) {
  const anchor = new Date(before.getTime() - 1_000)
  await prisma.luckyShadowCursor.upsert({
    where: { id: LUCKY_SHADOW_CURSOR_ID },
    create: { id: LUCKY_SHADOW_CURSOR_ID, lastCreatedAt: anchor, lastId: randomUUID() },
    update: { lastCreatedAt: anchor, lastId: randomUUID() },
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
    await prisma.luckyTierMode.updateMany({ data: { mode: 'off' } })
  })

  afterAll(async () => {
    await prisma.luckyTierMode.updateMany({ data: { mode: 'off' } })
    await prisma.luckyShadowCursor.deleteMany({})
    await prisma.$disconnect()
  })

  it('settle lag constant matches ledger timeout + maxWait + 30s buffer', () => {
    expect(shadowSettleLagMs()).toBe(SHADOW_SETTLE_LAG_MS)
    // B9: 15_000 + 10_000 + 30_000
    expect(SHADOW_SETTLE_LAG_MS).toBe(55_000)
  })

  it('fetchShadowGiftBatch excludes rows newer than the settle window', async () => {
    await prisma.luckyShadowCursor.deleteMany({})
    await prisma.luckyTierMode.upsert({
      where: { tierId: 'T100' },
      create: { tierId: 'T100', mode: 'shadow', updatedBy: 'test' },
      update: { mode: 'shadow', updatedBy: 'test' },
    })
    const sender = await makeUser()
    const gift = await makeLuckyGift(100)
    const now = new Date()
    const tooFresh = new Date(now.getTime() - 10_000)
    const settled = new Date(now.getTime() - SHADOW_SETTLE_LAG_MS - 5_000)
    await anchorShadowCursor(settled)

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
    await prisma.luckyTierMode.upsert({
      where: { tierId: 'T100' },
      create: { tierId: 'T100', mode: 'shadow', updatedBy: 'test' },
      update: { mode: 'shadow', updatedBy: 'test' },
    })
    await prisma.luckyTierPoolShadow.deleteMany({ where: { tierId: 'T100' } })
    await prisma.luckyTierPool.deleteMany({ where: { tierId: 'T100' } })
    await prisma.luckyShadowCursor.deleteMany({})

    const sender = await makeUser()
    const gift = await makeLuckyGift(100)
    const createdAt = new Date(Date.now() - SHADOW_SETTLE_LAG_MS - 2_000)
    await anchorShadowCursor(createdAt)
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
    await prisma.luckyTierMode.updateMany({ data: { mode: 'off' } })
    const r = await runShadowWorkerTick()
    expect(r.processed).toBe(0)
  })

  it('a missing cursor starts at now: historical lucky rows are never replayed', async () => {
    await prisma.luckyShadowCursor.deleteMany({})
    await prisma.luckyTierMode.upsert({
      where: { tierId: 'T100' },
      create: { tierId: 'T100', mode: 'shadow', updatedBy: 'test' },
      update: { mode: 'shadow', updatedBy: 'test' },
    })
    const sender = await makeUser()
    const gift = await makeLuckyGift(100)
    const old = await insertGiftTx({
      senderId: sender.id,
      giftId: gift.id,
      unitPrice: 100,
      quantity: 1,
      createdAt: new Date(Date.now() - 7 * 24 * 3600_000),
    })

    expect(await fetchShadowGiftBatch()).toEqual([])
    const cursor = await prisma.luckyShadowCursor.findUnique({ where: { id: LUCKY_SHADOW_CURSOR_ID } })
    expect(cursor?.lastCreatedAt).toBeTruthy()
    const next = await fetchShadowGiftBatch()
    expect(next.map((r) => r.id)).not.toContain(old.id)
  })

  it('ticks while no tier is in shadow keep the cursor parked at now', async () => {
    await prisma.luckyTierMode.updateMany({ data: { mode: 'off' } })
    const stale = new Date(Date.now() - 30 * 24 * 3600_000)
    await anchorShadowCursor(stale)
    await runShadowWorkerTick()
    const cursor = await prisma.luckyShadowCursor.findUnique({ where: { id: LUCKY_SHADOW_CURSOR_ID } })
    expect(cursor!.lastCreatedAt!.getTime()).toBeGreaterThan(Date.now() - SHADOW_SETTLE_LAG_MS - 60_000)
  })

  it('B9: row with created_at earlier than commit by maxWait+timeout-1s is still processed once', async () => {
    await prisma.luckyTierMode.upsert({
      where: { tierId: 'T100' },
      create: { tierId: 'T100', mode: 'shadow', updatedBy: 'test' },
      update: { mode: 'shadow', updatedBy: 'test' },
    })
    await prisma.luckyTierPoolShadow.deleteMany({ where: { tierId: 'T100' } })
    const sender = await makeUser()
    const gift = await makeLuckyGift(100)
    // Simulate created_at stamped at BEGIN, commit delayed by almost (maxWait+timeout).
    const skewMs = 10_000 + 15_000 - 1_000 // maxWait + timeout − 1s
    const createdAt = new Date(Date.now() - SHADOW_SETTLE_LAG_MS - 2_000 - skewMs)
    await anchorShadowCursor(createdAt)
    const tx = await insertGiftTx({
      senderId: sender.id,
      giftId: gift.id,
      unitPrice: 100,
      quantity: 1,
      createdAt,
    })
    const batch = await fetchShadowGiftBatch()
    expect(batch.map((r) => r.id)).toContain(tx.id)
    const row = batch.find((r) => r.id === tx.id)!
    expect(await processShadowGiftRow(row)).toBe('drawn')
    expect(await processShadowGiftRow(row)).toBe('noop')
  })
})
