/**
 * Phase 3 DB-backed water_v1 ledger checks (local Docker PG :5433).
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import { internalLedgerService } from '../../src/services/internalLedger.service'

const rid = () => randomUUID().replace(/-/g, '').slice(0, 12)

async function makeUser(coins: bigint) {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 80_000_000))
  const user = await prisma.user.create({
    data: {
      username: `lw_${rid()}`,
      publicId,
      defaultPublicId: publicId,
    },
  })
  if (coins > 0n) {
    const wallet = await prisma.wallet.create({
      data: { userId: user.id, currencyType: 'COIN' },
    })
    await prisma.coinLedgerEntry.create({
      data: {
        walletId: wallet.id,
        direction: 'CREDIT',
        txType: 'TOPUP',
        amount: coins,
        balanceAfter: coins,
        idempotencyKey: `seed-${rid()}`,
      },
    })
  }
  await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: user.id, currencyType: 'POINT' } },
    create: { userId: user.id, currencyType: 'POINT' },
    update: {},
  })
  return user
}

async function makeLuckyGift(coinCost: number) {
  return prisma.gift.create({
    data: {
      name: `lw_gift_${rid()}`,
      coinCost,
      displayImageUrl: 'https://example.invalid/g.png',
      code: `lw_${rid()}`,
      isActive: true,
      isLucky: true,
    },
  })
}

async function enforceTier(tierId: string, seedAmount: bigint) {
  await prisma.luckyTierConfig.updateMany({
    where: { tierId, version: 1 },
    data: { mode: 'enforce' },
  })
  await prisma.luckyTierSeedLog.create({
    data: {
      tierId,
      amount: seedAmount,
      adminId: 'test-admin',
      reason: 'phase3 test seed',
      choice: 'seed',
    },
  })
  await prisma.luckyTierPool.upsert({
    where: { tierId },
    create: { tierId, balance: seedAmount, configVersion: 1 },
    update: { balance: seedAmount, configVersion: 1 },
  })
}

describe('lucky water_v1 ledger (DB)', () => {
  beforeAll(async () => {
    const existing = await prisma.hostRevenueShareConfig.findFirst()
    if (!existing) await prisma.hostRevenueShareConfig.create({ data: { id: 1 } })
  })

  afterAll(async () => {
    // Leave modes off for other suites / ops safety on this throwaway DB.
    await prisma.luckyTierConfig.updateMany({ data: { mode: 'off' } })
    await prisma.$disconnect()
  })

  it('mode off + supportsServerDraw still uses legacy (engine=legacy) and writes reserve pool', async () => {
    await prisma.luckyTierConfig.updateMany({ where: { tierId: 'T100' }, data: { mode: 'off' } })
    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const txId = randomUUID()
    const before = await prisma.luckyReservePool.aggregate({ _sum: { totalSpent: true } })
    const r = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: txId,
      txKeyBase: `lucky:${txId}`,
      rewardCoins: '50',
      category: 'SMALL',
      supportsServerDraw: true,
    })
    expect(r.engine).toBe('legacy')
    expect(r.rewardCoins).toBe('50')
    const after = await prisma.luckyReservePool.aggregate({ _sum: { totalSpent: true } })
    expect((after._sum.totalSpent ?? 0n) - (before._sum.totalSpent ?? 0n)).toBe(100n)
  })

  it('legacy rejects combo reward > 2×S (F1)', async () => {
    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    await expect(
      internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: host.id,
        giftId: gift.id,
        count: 3,
        giftTransactionId: randomUUID(),
        txKeyBase: `lucky:${randomUUID()}`,
        rewardCoins: '601', // 2×S = 600
        category: 'WINNER',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_LUCKY_REWARD' })
  })

  it('water_v1: pool never below floor; F11 skips reserve; F5 replay returns stored balance', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(200_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `ctx_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const txId = randomUUID()
    const reserveBefore = await prisma.luckyReservePool.aggregate({ _sum: { totalSpent: true } })

    const first = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: txId,
      txKeyBase,
      rewardCoins: '0', // ignored by water_v1
      category: 'MISS',
      supportsServerDraw: true,
    })
    expect(first.engine).toBe('water_v1')
    expect(first.tierId).toBe('T100')
    expect(first.replayed).toBe(false)
    expect(BigInt(first.rewardCoins)).toBeGreaterThanOrEqual(0n)

    const pool = await prisma.luckyTierPool.findUnique({ where: { tierId: 'T100' } })
    expect(pool).toBeTruthy()
    expect(pool!.balance).toBeGreaterThanOrEqual(20_000n)

    const reserveAfter = await prisma.luckyReservePool.aggregate({ _sum: { totalSpent: true } })
    expect(reserveAfter._sum.totalSpent ?? 0n).toBe(reserveBefore._sum.totalSpent ?? 0n)

    const audit = await prisma.luckyDrawAudit.findUnique({ where: { idempotencyKey: txKeyBase } })
    expect(audit?.engine).toBe('water_v1')
    expect(audit?.paidReward.toString()).toBe(first.rewardCoins)

    // F5: new requestId, same clientTxId → stored result + original balance
    const replay = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS',
      supportsServerDraw: true,
    })
    expect(replay.replayed).toBe(true)
    expect(replay.engine).toBe('water_v1')
    expect(replay.rewardCoins).toBe(first.rewardCoins)
    expect(replay.finalBalanceCoins).toBe(first.finalBalanceCoins)
    expect(replay.category).toBe(first.category)

    // Fingerprint mismatch → 409
    await expect(
      internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: host.id,
        giftId: gift.id,
        count: 2,
        giftTransactionId: randomUUID(),
        txKeyBase,
        rewardCoins: '0',
        category: 'MISS',
        supportsServerDraw: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('water_v1 accepts ΣR > 2×S on combo (F1 engine-aware)', async () => {
    await enforceTier('T100', 100_000n)
    // Thin deterministic path: many units at high water → possible >2×; we only assert the path
    // does not throw INVALID_LUCKY_REWARD (water ignores client rewardCoins).
    const sender = await makeUser(500_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const r = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 3,
      giftTransactionId: randomUUID(),
      txKeyBase: `lucky:${sender.id}:${rid()}`,
      rewardCoins: '999999', // would fail legacy 2× check; water ignores
      category: 'WINNER',
      supportsServerDraw: true,
    })
    expect(r.engine).toBe('water_v1')
    expect(Array.isArray(r.breakdownArray)).toBe(true)
    expect(r.breakdownArray!.reduce((a, b) => a + b, 0)).toBe(Number(r.rewardCoins))
  })

  it('F9 rejects P=1 under water_v1', async () => {
    // T100 includes price 1; enforce + seed already from prior tests
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(10_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(1)
    await expect(
      internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: host.id,
        giftId: gift.id,
        count: 1,
        giftTransactionId: randomUUID(),
        txKeyBase: `lucky:${sender.id}:${rid()}`,
        rewardCoins: '0',
        category: 'MISS',
        supportsServerDraw: true,
      }),
    ).rejects.toMatchObject({ code: 'LUCKY_PRICE_TOO_LOW' })
  })
})
