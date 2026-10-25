/**
 * C2: pool-starvation regression — connection_limit=4, 10 concurrent water sends must succeed.
 * Also proves the nested-global-prisma guard fires.
 */
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import { internalLedgerService } from '../../src/services/internalLedger.service'
import {
  bustLuckyTierConfigCache,
  resolveEngine,
} from '../../src/services/luckyWater/resolveTier'
import { runInLuckyMoneyTx } from '../../src/services/luckyWater/luckyMoneyTxContext'

const rid = () => randomUUID().replace(/-/g, '').slice(0, 12)

async function makeUser(coins: bigint) {
  const publicId = BigInt(70_000_000 + Math.floor(Math.random() * 20_000_000))
  const user = await prisma.user.create({
    data: { username: `ps_${rid()}`, publicId, defaultPublicId: publicId },
  })
  const w = await prisma.wallet.create({ data: { userId: user.id, currencyType: 'COIN' } })
  await prisma.coinLedgerEntry.create({
    data: {
      walletId: w.id,
      direction: 'CREDIT',
      txType: 'TOPUP',
      amount: coins,
      balanceAfter: coins,
      idempotencyKey: `ps-seed-${rid()}`,
    },
  })
  await prisma.wallet.upsert({
    where: { userId_currencyType: { userId: user.id, currencyType: 'POINT' } },
    create: { userId: user.id, currencyType: 'POINT' },
    update: {},
  })
  return user
}

async function setMode(tierId: string, mode: 'off' | 'shadow' | 'enforce') {
  await prisma.luckyTierMode.upsert({
    where: { tierId },
    create: { tierId, mode, updatedBy: 'c2' },
    update: { mode, updatedBy: 'c2' },
  })
  bustLuckyTierConfigCache()
}

describe('C2 pool starvation (connection_limit=4)', () => {
  let giftId: string
  let hosts: string[]

  beforeAll(async () => {
    await setMode('T100', 'enforce')
    await prisma.luckyTierSeedLog.create({
      data: {
        tierId: 'T100',
        amount: 120_000n,
        adminId: 'c2',
        reason: 'healthy',
        choice: 'seed',
      },
    })
    await prisma.luckyTierPool.upsert({
      where: { tierId: 'T100' },
      create: { tierId: 'T100', balance: 120_000n, configVersion: 1 },
      update: { balance: 120_000n },
    })
    const gift = await prisma.gift.create({
      data: {
        name: `ps_g_${rid()}`,
        coinCost: 100,
        displayImageUrl: 'https://example.invalid/g.png',
        code: `ps_${rid()}`,
        isActive: true,
        isLucky: true,
      },
    })
    giftId = gift.id
    hosts = []
    for (let i = 0; i < 3; i++) hosts.push((await makeUser(0n)).id)
    bustLuckyTierConfigCache()
  })

  afterAll(async () => {
    await setMode('T100', 'off')
    await prisma.$disconnect()
  })

  it('C1 guard: global prisma inside ALS+money tx throws LUCKY_NESTED_PRISMA', async () => {
    await expect(
      prisma.$transaction(async (tx) =>
        runInLuckyMoneyTx('demo', async () => {
          // Intentionally use global client while "inside" a money tx — must fail.
          void tx
          await prisma.luckyTierConfig.findMany({ take: 1 })
        }),
      ),
    ).rejects.toThrow(/LUCKY_NESTED_PRISMA/)
  })

  it('pre-C1 pattern: nested global findMany under ALS is rejected by guard (starve prevented)', async () => {
    // After C1, resolveEngine uses tx only. Guard catches reintroduction of global findMany.
    // Full pre-C1 pool-starve evidence: docs/ops/tools/_c2_pre_c1_nested_starve.mjs
    await expect(
      prisma.$transaction(async (_tx) =>
        runInLuckyMoneyTx('pre-c1-sim', async () => {
          await prisma.luckyTierConfig.findMany({
            orderBy: [{ tierId: 'asc' }, { version: 'desc' }],
            take: 5,
          })
        }),
      ),
    ).rejects.toThrow(/LUCKY_NESTED_PRISMA/)
  })

  it('10 concurrent water_v1 enforce singles: zero acquire timeouts', async () => {
    const senders = []
    for (let i = 0; i < 10; i++) senders.push(await makeUser(5_000_000n))
    const results = await Promise.allSettled(
      senders.map((sender, i) =>
        internalLedgerService.luckyGiftSend({
          requestId: randomUUID(),
          senderId: sender.id,
          receiverId: hosts[i % hosts.length]!,
          giftId,
          count: 1,
          giftTransactionId: randomUUID(),
          txKeyBase: `lucky:${sender.id}:${rid()}`,
          rewardCoins: '0',
          category: 'MISS',
          supportsServerDraw: true,
        }),
      ),
    )
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    const rejectMsgs = rejected.map((r) => String(r.reason?.stack ?? r.reason)).join('\n---\n')
    const timeoutMsgs = rejected.filter((r) =>
      /Timed out fetching a new connection|timeout|maxWait|P2024/i.test(String(r.reason)),
    )
    expect(timeoutMsgs, rejectMsgs).toHaveLength(0)
    expect(results.filter((r) => r.status === 'fulfilled').length, rejectMsgs).toBe(10)
    for (const r of results) {
      if (r.status === 'fulfilled') expect(r.value.engine).toBe('water_v1')
    }
  })

  it('mixed 5 water + 5 legacy concurrent: zero acquire timeouts', async () => {
    const senders = []
    for (let i = 0; i < 10; i++) senders.push(await makeUser(5_000_000n))
    const results = await Promise.allSettled(
      senders.map((sender, i) =>
        internalLedgerService.luckyGiftSend({
          requestId: randomUUID(),
          senderId: sender.id,
          receiverId: hosts[i % hosts.length]!,
          giftId,
          count: 1,
          giftTransactionId: randomUUID(),
          txKeyBase: `lucky:${sender.id}:${rid()}`,
          rewardCoins: i >= 5 ? '0' : '0',
          category: 'MISS',
          // first 5 water (supportsServerDraw), last 5 legacy
          supportsServerDraw: i < 5,
        }),
      ),
    )
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(
      rejected.filter((r) => /Timed out fetching|P2024|maxWait/i.test(String(r.reason))),
    ).toHaveLength(0)
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(10)
  })

  it('10 concurrent water combos N=5: zero acquire timeouts', async () => {
    const senders = []
    for (let i = 0; i < 10; i++) senders.push(await makeUser(5_000_000n))
    const results = await Promise.allSettled(
      senders.map((sender, i) =>
        internalLedgerService.luckyGiftSend({
          requestId: randomUUID(),
          senderId: sender.id,
          receiverId: hosts[i % hosts.length]!,
          giftId,
          count: 5,
          giftTransactionId: randomUUID(),
          txKeyBase: `lucky:${sender.id}:${rid()}`,
          rewardCoins: '0',
          category: 'MISS',
          supportsServerDraw: true,
        }),
      ),
    )
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
    expect(
      rejected.filter((r) => /Timed out fetching|P2024|maxWait/i.test(String(r.reason))),
      rejected.map((r) => String(r.reason)).join('\n'),
    ).toHaveLength(0)
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(10)
  })

  it('resolveEngine inside tx does not throw nested-prisma guard', async () => {
    const r = await prisma.$transaction((tx) =>
      runInLuckyMoneyTx('resolve-ok', () => resolveEngine(tx, 100, true)),
    )
    expect(r.engine === 'water_v1' || r.engine === 'legacy').toBe(true)
  })
})
