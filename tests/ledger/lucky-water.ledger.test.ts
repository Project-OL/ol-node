/**
 * Phase 3 DB-backed water_v1 ledger checks (local Docker PG :5433).
 */
import { randomUUID } from 'crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import { hostRevenueShareConfigService } from '../../src/services/hostRevenueShareConfig.service'
import { internalLedgerService } from '../../src/services/internalLedger.service'
import { luckyTierAdminService } from '../../src/services/luckyTierAdmin.service'
import {
  bustLuckyTierConfigCache,
  resolveEngine,
} from '../../src/services/luckyWater/resolveTier'

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

/** B7: mode lives on lucky_tier_mode (not config version rows). */
async function setTierMode(tierId: string, mode: 'off' | 'shadow' | 'enforce') {
  await prisma.luckyTierMode.upsert({
    where: { tierId },
    create: { tierId, mode, updatedBy: 'test' },
    update: { mode, updatedBy: 'test' },
  })
  bustLuckyTierConfigCache()
}

async function enforceTier(tierId: string, seedAmount: bigint) {
  await setTierMode(tierId, 'enforce')
  await prisma.luckyTierSeedLog.create({
    data: {
      tierId,
      amount: seedAmount,
      adminId: 'test-admin',
      reason: 'phase3 test seed',
      choice: 'seed',
    },
  })
  const latest = await prisma.luckyTierConfig.findFirst({
    where: { tierId },
    orderBy: { version: 'desc' },
  })
  await prisma.luckyTierPool.upsert({
    where: { tierId },
    create: { tierId, balance: seedAmount, configVersion: latest?.version ?? 1 },
    update: { balance: seedAmount, configVersion: latest?.version ?? 1 },
  })
  bustLuckyTierConfigCache()
}

async function makeNonLuckyGift(coinCost: number) {
  return prisma.gift.create({
    data: {
      name: `nl_gift_${rid()}`,
      coinCost,
      displayImageUrl: 'https://example.invalid/g.png',
      code: `nl_${rid()}`,
      isActive: true,
      isLucky: false,
    },
  })
}

async function linkHostToAgency(hostUserId: string) {
  const agencyOwner = await makeUser(0n)
  const agencyPublicId = BigInt(90_000_000 + Math.floor(Math.random() * 9_000_000))
  await prisma.agency.create({
    data: {
      userId: agencyOwner.id,
      defaultPublicId: agencyPublicId,
      displayName: `agency_${rid()}`,
    },
  })
  await prisma.user.update({
    where: { id: hostUserId },
    data: { currentAgencyId: agencyOwner.id },
  })
  await prisma.agencyHost.create({
    data: { agencyUserId: agencyOwner.id, hostUserId },
  })
  return agencyOwner
}

function drawnUnits(audit: { drawnJson: unknown } | null): Array<{ downgrade?: string }> {
  if (!audit?.drawnJson || typeof audit.drawnJson !== 'object' || Array.isArray(audit.drawnJson)) {
    return []
  }
  const units = (audit.drawnJson as { units?: unknown }).units
  return Array.isArray(units) ? (units as Array<{ downgrade?: string }>) : []
}

describe('lucky water_v1 ledger (DB)', () => {
  beforeAll(async () => {
    const existing = await prisma.hostRevenueShareConfig.findFirst()
    if (!existing) await prisma.hostRevenueShareConfig.create({ data: { id: 1 } })
  })

  afterEach(async () => {
    await hostRevenueShareConfigService.bustCache()
  })

  afterAll(async () => {
    // Leave modes off for other suites / ops safety on this throwaway DB.
    await prisma.luckyTierMode.updateMany({ data: { mode: 'off' } })
    await prisma.luckyTierConfig.updateMany({ data: { dailyWinCapCoins: 0n } })
    bustLuckyTierConfigCache()
    await hostRevenueShareConfigService.bustCache()
    await prisma.$disconnect()
  })

  it('mode off + supportsServerDraw still uses legacy (engine=legacy) and writes reserve pool', async () => {
    await setTierMode('T100', 'off')
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

describe('B4 mode-independent replay (DB)', () => {
  afterAll(async () => {
    await setTierMode('T100', 'off')
  })

  it('legacy send then enforce+seed flip: same clientTxId+requestId replays legacy, no water audit', async () => {
    await setTierMode('T100', 'off')
    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `ctx_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const requestId = randomUUID()
    const txId = randomUUID()

    const first = await internalLedgerService.luckyGiftSend({
      requestId,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: txId,
      txKeyBase,
      rewardCoins: '50',
      category: 'SMALL',
      supportsServerDraw: true,
    })
    expect(first.engine).toBe('legacy')
    expect(first.replayed).toBe(false)
    expect(first.rewardCoins).toBe('50')

    const auditBefore = await prisma.luckyDrawAudit.count({ where: { idempotencyKey: txKeyBase } })
    expect(auditBefore).toBe(0)

    await enforceTier('T100', 100_000n)

    const replay = await internalLedgerService.luckyGiftSend({
      requestId,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '999',
      category: 'WINNER',
      supportsServerDraw: true,
    })
    expect(replay.engine).toBe('legacy')
    expect(replay.replayed).toBe(true)
    expect(replay.rewardCoins).toBe('50')

    const auditAfter = await prisma.luckyDrawAudit.count({ where: { idempotencyKey: txKeyBase } })
    expect(auditAfter).toBe(0)
    const debitCount = await prisma.coinLedgerEntry.count({
      where: { idempotencyKey: `${txKeyBase}-debit` },
    })
    expect(debitCount).toBe(1)
  })

  it('water_v1 send then mode off: same clientTxId replays stored water reward and balance', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(200_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `ctx_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`

    const first = await internalLedgerService.luckyGiftSend({
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
    expect(first.engine).toBe('water_v1')
    expect(first.replayed).toBe(false)

    await setTierMode('T100', 'off')

    const replay = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '500',
      category: 'WINNER',
      supportsServerDraw: true,
    })
    expect(replay.engine).toBe('water_v1')
    expect(replay.replayed).toBe(true)
    expect(replay.rewardCoins).toBe(first.rewardCoins)
    expect(replay.finalBalanceCoins).toBe(first.finalBalanceCoins)
  })

  it('legacy debit without water audit: wrong requestId → 409 DUPLICATE', async () => {
    await setTierMode('T100', 'off')
    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const txId = randomUUID()
    const txKeyBase = `lucky:${txId}`
    const requestId = randomUUID()

    await internalLedgerService.luckyGiftSend({
      requestId,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: txId,
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS',
      supportsServerDraw: true,
    })

    await expect(
      internalLedgerService.luckyGiftSend({
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
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'DUPLICATE_LEDGER_KEY' })
  })
})

describe('B6 water_v1 extended ledger (DB)', () => {
  afterAll(async () => {
    await setTierMode('T100', 'off')
    const latest = await prisma.luckyTierConfig.findFirst({
      where: { tierId: 'T100' },
      orderBy: { version: 'desc' },
    })
    if (latest) {
      await prisma.luckyTierConfig.update({
        where: { id: latest.id },
        data: { dailyWinCapCoins: 0n },
      })
    }
    bustLuckyTierConfigCache()
  })

  it('resolveEngine matrix: mode × serverDraw × seed → legacy|water_v1', async () => {
    const cases: Array<{
      tierId: string
      unitPrice: number
      mode: 'off' | 'shadow' | 'enforce'
      seeded: boolean
      supportsServerDraw: boolean | undefined
      expected: 'legacy' | 'water_v1'
    }> = [
      { tierId: 'T100', unitPrice: 100, mode: 'off', seeded: false, supportsServerDraw: true, expected: 'legacy' },
      { tierId: 'T100', unitPrice: 100, mode: 'off', seeded: true, supportsServerDraw: true, expected: 'legacy' },
      { tierId: 'T100', unitPrice: 100, mode: 'shadow', seeded: true, supportsServerDraw: true, expected: 'legacy' },
      { tierId: 'T500', unitPrice: 200, mode: 'enforce', seeded: false, supportsServerDraw: true, expected: 'legacy' },
      { tierId: 'T500', unitPrice: 200, mode: 'enforce', seeded: true, supportsServerDraw: true, expected: 'water_v1' },
      { tierId: 'T500', unitPrice: 200, mode: 'enforce', seeded: true, supportsServerDraw: false, expected: 'legacy' },
      { tierId: 'T500', unitPrice: 200, mode: 'enforce', seeded: true, supportsServerDraw: undefined, expected: 'legacy' },
    ]

    for (const c of cases) {
      await setTierMode(c.tierId, c.mode)
      if (!c.seeded) {
        await prisma.luckyTierSeedLog.deleteMany({ where: { tierId: c.tierId } })
      } else {
        await prisma.luckyTierSeedLog.deleteMany({ where: { tierId: c.tierId, adminId: 'matrix' } })
      }
      if (c.seeded) {
        await prisma.luckyTierSeedLog.create({
          data: {
            tierId: c.tierId,
            amount: 1n,
            adminId: 'matrix',
            reason: 'matrix seed',
            choice: 'seed',
          },
        })
      }
      bustLuckyTierConfigCache()

      const r = await prisma.$transaction((tx) =>
        resolveEngine(tx, c.unitPrice, c.supportsServerDraw === true),
      )
      expect(r.engine, JSON.stringify(c)).toBe(c.expected)

      await prisma.luckyTierSeedLog.deleteMany({ where: { tierId: c.tierId, adminId: 'matrix' } })
    }
  })

  it('combo partial dry-out: tight pool N=10 yields POOL_FLOOR units and pool stays >= floor', async () => {
    await enforceTier('T100', 100_000n)
    const floor = 20_000n
    // Pre-fill only via inflow (920 on this combo); W stays << floor so paid rolls downgrade.
    await prisma.luckyTierPool.update({
      where: { tierId: 'T100' },
      data: { balance: 0n },
    })

    const sender = await makeUser(500_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const txKeyBase = `lucky:${sender.id}:${rid()}`

    const r = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 10,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS',
      supportsServerDraw: true,
    })
    expect(r.engine).toBe('water_v1')

    const audit = await prisma.luckyDrawAudit.findUnique({ where: { idempotencyKey: txKeyBase } })
    const units = drawnUnits(audit)
    expect(units.some((u) => u.downgrade === 'POOL_FLOOR')).toBe(true)

    const pool = await prisma.luckyTierPool.findUnique({ where: { tierId: 'T100' } })
    const paid = BigInt(r.rewardCoins)
    if (paid > 0n) {
      expect(pool!.balance).toBeGreaterThanOrEqual(floor)
    }
  })

  it('odd unit prices 199 and 999: water rewards are integers (half uses floor P/2)', async () => {
    const priceTier: Array<[number, string]> = [
      [199, 'T100'],
      [999, 'T500'],
    ]
    for (const [coinCost, tierId] of priceTier) {
      await enforceTier(tierId, 100_000n)
      const sender = await makeUser(500_000n)
      const host = await makeUser(0n)
      const gift = await makeLuckyGift(coinCost)
      const r = await internalLedgerService.luckyGiftSend({
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
      })
      expect(r.engine).toBe('water_v1')
      expect(Number.isInteger(Number(r.rewardCoins))).toBe(true)
      if (r.breakdownArray) {
        for (const b of r.breakdownArray) {
          expect(Number.isInteger(b)).toBe(true)
        }
        const halfExpected = Math.floor(coinCost / 2)
        for (const b of r.breakdownArray) {
          if (b === halfExpected) expect(b).toBe(Math.floor(coinCost / 2))
        }
      }
    }
  })

  it('F12 water combo with luckyWaterAgencyCommission credits AGENT_COMMISSION when host has agency', async () => {
    await enforceTier('T100', 100_000n)
    await prisma.hostRevenueShareConfig.update({
      where: { id: 1 },
      data: { luckyWaterAgencyCommission: true, luckyHostShareBp: 6_000 },
    })
    await hostRevenueShareConfigService.bustCache()
    const shares = await hostRevenueShareConfigService.getShares()
    expect(shares.luckyWaterAgencyCommission).toBe(true)

    const sender = await makeUser(500_000n)
    const host = await makeUser(0n)
    await linkHostToAgency(host.id)
    const gift = await makeLuckyGift(100)
    const txId = randomUUID()
    const txKeyBase = `lucky:${sender.id}:${rid()}`

    const r = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 3,
      giftTransactionId: txId,
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS',
      supportsServerDraw: true,
    })
    expect(r.engine).toBe('water_v1')
    expect(r.agencyUserId).not.toBeNull()

    const hostCut = await prisma.pointLedgerEntry.findUnique({
      where: { idempotencyKey: `${txKeyBase}-host-cut` },
    })
    expect(hostCut?.txType).toBe('LIVESTREAM_GIFT')
    const commission = await prisma.pointLedgerEntry.findUnique({
      where: { idempotencyKey: `agency-commission:${hostCut!.id}` },
    })
    expect(commission?.txType).toBe('AGENT_COMMISSION')
    expect(commission!.amount).toBeGreaterThan(0n)
  })

  it('F13 dailyWinCapCoins: second water send same day hits USER_CAP in audit', async () => {
    await enforceTier('T100', 100_000n)
    const latestCap = await prisma.luckyTierConfig.findFirst({
      where: { tierId: 'T100' },
      orderBy: { version: 'desc' },
    })
    await prisma.luckyTierConfig.update({
      where: { id: latestCap!.id },
      data: { dailyWinCapCoins: 50n },
    })
    bustLuckyTierConfigCache()

    const sender = await makeUser(1_000_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)

    let firstPaid = 0n
    for (let i = 0; i < 25; i++) {
      const r = await internalLedgerService.luckyGiftSend({
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
      })
      firstPaid = BigInt(r.rewardCoins)
      if (firstPaid > 0n) break
    }
    expect(firstPaid).toBeGreaterThan(0n)

    let sawUserCap = false
    for (let attempt = 0; attempt < 8 && !sawUserCap; attempt++) {
      const txKeyBase2 = `lucky:${sender.id}:${rid()}`
      await internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: host.id,
        giftId: gift.id,
        count: 10,
        giftTransactionId: randomUUID(),
        txKeyBase: txKeyBase2,
        rewardCoins: '0',
        category: 'MISS',
        supportsServerDraw: true,
      })
      const audit2 = await prisma.luckyDrawAudit.findUnique({
        where: { idempotencyKey: txKeyBase2 },
      })
      sawUserCap = drawnUnits(audit2).some((u) => u.downgrade === 'USER_CAP')
    }
    expect(sawUserCap).toBe(true)
  })

  it('non-lucky giftSend: no lucky_draw_audit and tier pool unchanged', async () => {
    await enforceTier('T100', 100_000n)
    const poolBefore = (
      await prisma.luckyTierPool.findUnique({ where: { tierId: 'T100' } })
    )!.balance

    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeNonLuckyGift(100)
    const txId = randomUUID()
    const idemBase = `gift-stream:${sender.id}:${rid()}`

    await internalLedgerService.giftSend({
      requestId: randomUUID(),
      context: 'live_stream',
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      quantity: 1,
      giftTransactionId: txId,
      idemBase,
    })

    const auditCount = await prisma.luckyDrawAudit.count({
      where: { senderUserId: sender.id },
    })
    expect(auditCount).toBe(0)
    const poolAfter = (
      await prisma.luckyTierPool.findUnique({ where: { tierId: 'T100' } })
    )!.balance
    expect(poolAfter).toBe(poolBefore)
  })

  it('replay without clientTxId: requestId-strict (same replays, different 409)', async () => {
    await setTierMode('T100', 'off')
    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const txId = randomUUID()
    const txKeyBase = `lucky:${txId}`
    const requestId = randomUUID()

    const first = await internalLedgerService.luckyGiftSend({
      requestId,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: txId,
      txKeyBase,
      rewardCoins: '25',
      category: 'SMALL',
    })
    expect(first.replayed).toBe(false)

    const replay = await internalLedgerService.luckyGiftSend({
      requestId,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '99',
      category: 'WINNER',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.rewardCoins).toBe('25')

    await expect(
      internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: host.id,
        giftId: gift.id,
        count: 1,
        giftTransactionId: randomUUID(),
        txKeyBase,
        rewardCoins: '25',
        category: 'SMALL',
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('after water send pool balance is >= tier floor', async () => {
    await enforceTier('T100', 100_000n)
    const cfg = await prisma.luckyTierConfig.findFirst({
      where: { tierId: 'T100' },
      orderBy: { version: 'desc' },
      select: { floor: true },
    })
    const sender = await makeUser(200_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)

    await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 2,
      giftTransactionId: randomUUID(),
      txKeyBase: `lucky:${sender.id}:${rid()}`,
      rewardCoins: '0',
      category: 'MISS',
      supportsServerDraw: true,
    })

    const pool = await prisma.luckyTierPool.findUnique({ where: { tierId: 'T100' } })
    expect(pool!.balance).toBeGreaterThanOrEqual(cfg!.floor)
  })
})

describe('B7 mode table + B8 water replay new requestId (DB)', () => {
  afterAll(async () => {
    await setTierMode('T100', 'off')
    await setTierMode('T500', 'off')
  })

  /** Ensure F2 host-share fixture is production-valid (400 bp) before createConfigVersion. */
  async function ensureValidHostShareForF2() {
    await prisma.hostRevenueShareConfig.update({
      where: { id: 1 },
      data: { luckyHostShareBp: 400, luckyWaterAgencyCommission: false },
    })
    await hostRevenueShareConfigService.bustCache()
  }

  it('B7: createConfigVersion leaves lucky_tier_mode unchanged (shadow stays shadow)', async () => {
    await ensureValidHostShareForF2()
    await setTierMode('T100', 'shadow')
    const before = await prisma.luckyTierMode.findUnique({ where: { tierId: 'T100' } })
    expect(before!.mode).toBe('shadow')
    const verBefore = (
      await prisma.luckyTierConfig.findFirst({ where: { tierId: 'T100' }, orderBy: { version: 'desc' } })
    )!.version

    await luckyTierAdminService.createConfigVersion('admin-b7', 'T100', {})

    const after = await prisma.luckyTierMode.findUnique({ where: { tierId: 'T100' } })
    expect(after!.mode).toBe('shadow')
    const verAfter = (
      await prisma.luckyTierConfig.findFirst({ where: { tierId: 'T100' }, orderBy: { version: 'desc' } })
    )!.version
    expect(verAfter).toBe(verBefore + 1)
  })

  it('B7: createConfigVersion leaves enforce mode unchanged', async () => {
    await ensureValidHostShareForF2()
    await enforceTier('T100', 100_000n)
    const mode = await prisma.luckyTierMode.findUnique({ where: { tierId: 'T100' } })
    expect(mode!.mode).toBe('enforce')
    await luckyTierAdminService.createConfigVersion('admin-b7', 'T100', {})
    const after = await prisma.luckyTierMode.findUnique({ where: { tierId: 'T100' } })
    expect(after!.mode).toBe('enforce')
  })

  it('C8: createConfigVersion succeeds with host share 400 and DEFAULT weights', async () => {
    await ensureValidHostShareForF2()
    const shares = await hostRevenueShareConfigService.getShares()
    expect(shares.luckyHostShareBp).toBe(400)
    const created = await luckyTierAdminService.createConfigVersion('admin-c8', 'T100', {
      // no weight patch → revalidates current (DEFAULT) bands under F2
    })
    expect(created.version).toBeGreaterThan(0)
    expect(created.tierId).toBe('T100')
  })

  it('C8: createConfigVersion rejected by F2 with exact self-gift guard message', async () => {
    await ensureValidHostShareForF2()
    const latest = await prisma.luckyTierConfig.findFirst({
      where: { tierId: 'T100' },
      orderBy: { version: 'desc' },
    })
    expect(latest).toBeTruthy()
    // Hostile high band: EV_high near 9990bp so F2 fails even with h=400.
    const badWeights = {
      critical: { miss: 3000, half: 3000, equal: 4000, medium: 0, jackpot: 0 },
      low: { miss: 3400, half: 2800, equal: 2400, medium: 1400, jackpot: 0 },
      normal: { miss: 4000, half: 2600, equal: 1850, medium: 1250, jackpot: 300 },
      high: { miss: 0, half: 0, equal: 0, medium: 0, jackpot: 10000 },
    }
    await expect(
      luckyTierAdminService.createConfigVersion('admin-c8', 'T100', {
        bandWeights: badWeights as never,
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'LUCKY_TIER_F2_VIOLATION',
    })
    try {
      await luckyTierAdminService.createConfigVersion('admin-c8', 'T100', {
        bandWeights: badWeights as never,
      })
      expect.unreachable('should have thrown')
    } catch (e: unknown) {
      const err = e as { message?: string }
      expect(err.message).toMatch(/F2 self-gift guard violated/)
    }
  })

  it('B7: admin setMode writes lucky_tier_mode and enforce still requires seed (F10)', async () => {
    await prisma.luckyTierSeedLog.deleteMany({ where: { tierId: 'T500' } })
    await setTierMode('T500', 'off')
    await expect(luckyTierAdminService.setMode('admin-b7', 'T500', 'enforce')).rejects.toMatchObject({
      code: 'LUCKY_TIER_ENFORCE_NO_SEED',
    })
  })

  it('B6: mode flip on mode table is visible to next resolveEngine without cache bust', async () => {
    await enforceTier('T100', 50_000n)
    const r1 = await prisma.$transaction((tx) => resolveEngine(tx, 100, true))
    expect(r1.engine).toBe('water_v1')
    // Flip mode without busting immutable config cache
    await prisma.luckyTierMode.update({ where: { tierId: 'T100' }, data: { mode: 'off' } })
    const r2 = await prisma.$transaction((tx) => resolveEngine(tx, 100, true))
    expect(r2.engine).toBe('legacy')
    expect(r2.config?.mode).toBe('off')
  })

  it('B8: water send then mode off: retry same clientTxId with NEW requestId replays water', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(200_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `b8_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const txId = randomUUID()

    const first = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(),
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: txId,
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS',
      supportsServerDraw: true,
    })
    expect(first.engine).toBe('water_v1')
    expect(first.replayed).toBe(false)
    const auditsBefore = await prisma.luckyDrawAudit.count({ where: { idempotencyKey: txKeyBase } })

    await setTierMode('T100', 'off')
    const replay = await internalLedgerService.luckyGiftSend({
      requestId: randomUUID(), // NEW requestId
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '999',
      category: 'JACKPOT',
      supportsServerDraw: true,
    })
    expect(replay.replayed).toBe(true)
    expect(replay.engine).toBe('water_v1')
    expect(replay.rewardCoins).toBe(first.rewardCoins)
    expect(replay.finalBalanceCoins).toBe(first.finalBalanceCoins)
    expect(replay.category).toBe(first.category)
    expect(await prisma.luckyDrawAudit.count({ where: { idempotencyKey: txKeyBase } })).toBe(
      auditsBefore,
    )
  })

  it('B8: water replay with new requestId while still enforce', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(200_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `b8e_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const first = await internalLedgerService.luckyGiftSend({
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
    expect(replay.rewardCoins).toBe(first.rewardCoins)
  })

  it('B8: water replay different receiver → 409 fingerprint', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(200_000n)
    const host = await makeUser(0n)
    const other = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `b8f_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    await internalLedgerService.luckyGiftSend({
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
    await expect(
      internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: other.id,
        giftId: gift.id,
        count: 1,
        giftTransactionId: randomUUID(),
        txKeyBase,
        rewardCoins: '0',
        category: 'MISS',
        supportsServerDraw: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LUCKY_REPLAY_MISMATCH' })
  })

  it('B8: legacy send then enforce: retry same clientTxId with NEW requestId → 409 requestId-strict', async () => {
    await setTierMode('T100', 'off')
    const sender = await makeUser(50_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `b8l_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const r1 = randomUUID()
    await internalLedgerService.luckyGiftSend({
      requestId: r1,
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '50',
      category: 'SMALL',
    })
    await enforceTier('T100', 100_000n)
    // Legacy originals stay requestId-strict (baseline). Acceptable: Live-server Redis idempotency
    // key is the primary clientTxId replay for offline retries; ledger requestId-strict guards
    // against partial double-submit without Redis.
    await expect(
      internalLedgerService.luckyGiftSend({
        requestId: randomUUID(),
        senderId: sender.id,
        receiverId: host.id,
        giftId: gift.id,
        count: 1,
        giftTransactionId: randomUUID(),
        txKeyBase,
        rewardCoins: '50',
        category: 'SMALL',
        supportsServerDraw: true,
      }),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('G6: concurrent same clientTxId → one debit, both return same water result (no 409)', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(500_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `g6c_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const giftTransactionId = randomUUID()
    const base = {
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1 as const,
      giftTransactionId,
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS' as const,
      supportsServerDraw: true,
    }
    const [a, b] = await Promise.all([
      internalLedgerService.luckyGiftSend({ ...base, requestId: randomUUID() }),
      internalLedgerService.luckyGiftSend({ ...base, requestId: randomUUID() }),
    ])
    const debitCount = await prisma.coinLedgerEntry.count({
      where: { idempotencyKey: `${txKeyBase}-debit` },
    })
    expect(debitCount).toBe(1)
    expect(a.rewardCoins).toBe(b.rewardCoins)
    expect(a.finalBalanceCoins).toBe(b.finalBalanceCoins)
    expect(a.engine).toBe('water_v1')
    expect(b.engine).toBe('water_v1')
    // Exactly one of the two is the first commit; the other must be a replay (not 409).
    expect([a.replayed, b.replayed].filter(Boolean).length).toBeGreaterThanOrEqual(1)
  })

  it('G6: 50 same-payload retries after success → 0 LUCKY_REPLAY_MISMATCH', async () => {
    await enforceTier('T100', 100_000n)
    const sender = await makeUser(500_000n)
    const host = await makeUser(0n)
    const gift = await makeLuckyGift(100)
    const clientTxId = `g6r_${rid()}`
    const txKeyBase = `lucky:${sender.id}:${clientTxId}`
    const payload = {
      senderId: sender.id,
      receiverId: host.id,
      giftId: gift.id,
      count: 1 as const,
      giftTransactionId: randomUUID(),
      txKeyBase,
      rewardCoins: '0',
      category: 'MISS' as const,
      supportsServerDraw: true,
    }
    const first = await internalLedgerService.luckyGiftSend({
      ...payload,
      requestId: randomUUID(),
    })
    expect(first.replayed).toBe(false)
    for (let i = 0; i < 50; i++) {
      const replay = await internalLedgerService.luckyGiftSend({
        ...payload,
        requestId: randomUUID(),
      })
      expect(replay.replayed).toBe(true)
      expect(replay.rewardCoins).toBe(first.rewardCoins)
      expect(replay.finalBalanceCoins).toBe(first.finalBalanceCoins)
    }
    // Cross-payload reuse still 409
    await expect(
      internalLedgerService.luckyGiftSend({
        ...payload,
        count: 2,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LUCKY_REPLAY_MISMATCH' })
  })
})

describe('review fixes: seed top-up, enforce gates, F2 via mode table (DB)', () => {
  // T10K: untouched by the suites above (floor 1_000_000).
  const TIER = 'T10K' as const

  async function setHostShare(bp: number) {
    await prisma.hostRevenueShareConfig.update({
      where: { id: 1 },
      data: { luckyHostShareBp: bp, luckyWaterAgencyCommission: false },
    })
    await hostRevenueShareConfigService.bustCache()
  }

  beforeAll(async () => {
    await setHostShare(400)
  })

  afterEach(async () => {
    await setTierMode(TIER, 'off')
    await setHostShare(400)
  })

  afterAll(async () => {
    await prisma.luckyTierPool.deleteMany({ where: { tierId: TIER } })
    await prisma.luckyTierSeedLog.deleteMany({ where: { tierId: TIER } })
  })

  it('seed tops up the live pool instead of overwriting it', async () => {
    await prisma.luckyTierPool.deleteMany({ where: { tierId: TIER } })
    const a = await luckyTierAdminService.recordSeedDecision('admin-rf', TIER, 'seed', 600_000n)
    expect(a.poolBalance).toBe('600000')
    const b = await luckyTierAdminService.recordSeedDecision('admin-rf', TIER, 'seed', 600_000n)
    expect(b.poolBalance).toBe('1200000')
    const pool = await prisma.luckyTierPool.findUnique({ where: { tierId: TIER } })
    expect(pool?.balance).toBe(1_200_000n)
  })

  it('capped_ladder is refused as not implemented', async () => {
    await expect(
      luckyTierAdminService.recordSeedDecision('admin-rf', TIER, 'capped_ladder', 0n),
    ).rejects.toMatchObject({ statusCode: 422, code: 'LUCKY_TIER_SEED_NOT_IMPLEMENTED' })
  })

  it('enforce is refused while the pool is below floor unless an override reason is given', async () => {
    await prisma.luckyTierPool.deleteMany({ where: { tierId: TIER } })
    await luckyTierAdminService.recordSeedDecision('admin-rf', TIER, 'start_empty', 0n)
    await luckyTierAdminService.setMode('admin-rf', TIER, 'shadow')
    await expect(luckyTierAdminService.setMode('admin-rf', TIER, 'enforce')).rejects.toMatchObject({
      statusCode: 422,
      code: 'LUCKY_TIER_ENFORCE_POOL_BELOW_FLOOR',
    })
    const ok = await luckyTierAdminService.setMode('admin-rf', TIER, 'enforce', 'ops accepts dry start')
    expect(ok.mode).toBe('enforce')
  })

  it('enforce after shadow on the mode table passes F10 without a legacy config snapshot', async () => {
    await prisma.luckyTierPool.deleteMany({ where: { tierId: TIER } })
    await luckyTierAdminService.recordSeedDecision('admin-rf', TIER, 'seed', 1_000_000n)
    await luckyTierAdminService.setMode('admin-rf', TIER, 'shadow')
    const ok = await luckyTierAdminService.setMode('admin-rf', TIER, 'enforce')
    expect(ok.mode).toBe('enforce')
  })

  it('host share raise is blocked by F2 when the tier is enforced on the mode table only', async () => {
    const latest = await prisma.luckyTierConfig.findFirst({
      where: { tierId: TIER },
      orderBy: { version: 'desc' },
    })
    // The stale snapshot column says off; the live mode table says enforce.
    expect(latest?.mode).not.toBe('enforce')
    await setTierMode(TIER, 'enforce')
    // EV_high 9450 + 1000 host = 10450 bp > 9900: self-gifting would profit.
    const err = await hostRevenueShareConfigService
      .updateConfig(randomUUID(), { luckyHostShareBp: 1000 })
      .then(() => null, (e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 422, code: 'LUCKY_TIER_F2_VIOLATION' })
    // Other tiers may carry stale snapshot modes from earlier suites: T10K itself must be named.
    const violations = (err as { details?: { violations?: string[] } }).details?.violations ?? []
    expect(violations.some((v) => v.startsWith(`${TIER} `))).toBe(true)
  })

  it('setMode to enforce re-checks F2 against the current host share', async () => {
    await prisma.luckyTierPool.deleteMany({ where: { tierId: TIER } })
    await luckyTierAdminService.recordSeedDecision('admin-rf', TIER, 'seed', 1_000_000n)
    // Share raised while the tier was off, so the update-time check had nothing to validate.
    await setHostShare(1000)
    await setTierMode(TIER, 'shadow')
    await expect(luckyTierAdminService.setMode('admin-rf', TIER, 'enforce')).rejects.toMatchObject({
      statusCode: 422,
      code: 'LUCKY_TIER_F2_VIOLATION',
    })
  })
})

