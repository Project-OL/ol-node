/**
 * BE-24: admin lists filtered to a country-restricted admin's countries, against a real Postgres
 * (env.setup.ts). Every user a row involves must be in the countries.
 */
import { randomBytes, randomUUID } from 'crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../src/config/database'
import { redisClient } from '../../src/config/redis'
import { adminTransactionsService } from '../../src/services/adminTransactions.service'
import { payrollAdminService } from '../../src/services/payrollAdmin.service'
import { adminUserSearchService } from '../../src/services/adminUserSearch.service'

const rid = () => randomBytes(6).toString('hex')
// A country no other test uses, so counts are exact.
const C = `Testland-${rid()}`
const OTHER = `Otherland-${rid()}`

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

async function user(country: string) {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999))
  return prisma.user.create({
    data: { username: `c_${rid()}`, publicId, defaultPublicId: publicId, country },
  })
}

describe('BE-24 country-filtered admin lists', () => {
  it('gifts, point ledger, pending withdrawals and user stats only show in-scope users', async () => {
    const [a, b, x] = [await user(C), await user(C), await user(OTHER)]
    const gift = await prisma.gift.create({
      data: { name: `g_${rid()}`, coinCost: 10, displayImageUrl: 'https://example.invalid/g.png', code: `g_${rid()}` },
    })
    const inScope = await prisma.giftTransaction.create({
      data: { senderUserId: a.id, receiverUserId: b.id, giftId: gift.id, coinCost: 10, pointsAwarded: 6 },
    })
    const mixed = await prisma.giftTransaction.create({
      data: { senderUserId: a.id, receiverUserId: x.id, giftId: gift.id, coinCost: 10, pointsAwarded: 6 },
    })

    const withdrawalOf = new Map<string, string>()
    for (const u of [a, x]) {
      const w = await prisma.wallet.create({ data: { userId: u.id, currencyType: 'POINT' } })
      await prisma.pointLedgerEntry.create({
        data: { walletId: w.id, direction: 'CREDIT', txType: 'ADJUSTMENT', amount: 5n, balanceAfter: 5n, idempotencyKey: `seed-${rid()}` },
      })
      const wd = await prisma.withdrawal.create({
        data: {
          walletId: w.id,
          userId: u.id,
          amountPoints: 200_000n,
          status: 'PENDING_PLATFORM',
          methodType: 'EPAY',
          payoutHandler: 'PLATFORM',
          idempotencyKey: `withdrawal:${u.id}:${randomUUID()}`,
          withdrawalVersion: 2,
        },
      })
      withdrawalOf.set(u.id, wd.id)
    }

    const scope = { countries: [C] }
    const q = { limit: 100 } as Parameters<typeof adminTransactionsService.listGiftTransactions>[0]

    const gifts = await adminTransactionsService.listGiftTransactions(q, scope)
    const giftIds = gifts.entries.map((e) => e.id)
    expect(giftIds).toContain(inScope.id)
    expect(giftIds).not.toContain(mixed.id)
    expect(gifts.entries.every((e) => [a.id, b.id].includes(e.sender!.userId) && [a.id, b.id].includes(e.receiver!.userId))).toBe(true)
    // unscoped (SUPER_ADMIN) still sees both
    const all = await adminTransactionsService.listGiftTransactions(q)
    expect(all.entries.map((e) => e.id)).toEqual(expect.arrayContaining([inScope.id, mixed.id]))

    const points = await adminTransactionsService.listPointTransactions(q, scope)
    const pointWallets = new Set(points.entries.map((e) => (e as { walletUserId?: string; userId?: string }).walletUserId ?? (e as { userId?: string }).userId))
    expect(pointWallets.has(x.id)).toBe(false)
    expect(points.entries.length).toBeGreaterThan(0)

    const pending = await payrollAdminService.listPendingPlatformWithdrawals({ limit: 50, countries: [C] })
    const pendingIds = new Set(pending.items.map((w) => w.id))
    expect(pendingIds.has(withdrawalOf.get(a.id)!)).toBe(true)
    expect(pendingIds.has(withdrawalOf.get(x.id)!)).toBe(false)

    const stats = await adminUserSearchService.getRegistrationStats([C])
    expect(stats.totalUsers).toBe(2)
    expect(stats.users.map((u) => u.userId).sort()).toEqual([a.id, b.id].sort())
  })
})
