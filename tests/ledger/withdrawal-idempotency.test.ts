/**
 * F04: the withdrawal client key is guaranteed by Postgres (withdrawals.idempotency_key, unique,
 * written with the debit), not by the Redis marker. Real throwaway Postgres (env.setup.ts); only
 * the face check, rail switch and outbound message queue are stubbed.
 */
import { randomBytes } from 'crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: { isIndexedForUser: vi.fn().mockResolvedValue(true) },
}))
vi.mock('../../src/services/withdrawalPayoutRailConfig.service', () => ({
  withdrawalPayoutRailConfigService: { assertRailEnabled: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../src/queues/platform-message.queue', () => ({
  enqueuePlatformWithdrawalMessage: vi.fn().mockResolvedValue(undefined),
  enqueuePlatformLedgerMessage: vi.fn().mockResolvedValue(undefined),
}))

import { prisma } from '../../src/config/database'
import { redisClient, RedisKeys } from '../../src/config/redis'
import { withdrawalService } from '../../src/services/withdrawal.service'

const rid = () => randomBytes(6).toString('hex')
const GROSS = 200_000n // $20 at 10,000 points per USD

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

beforeAll(async () => {
  await prisma.payrollConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
})

async function makeHost(points: bigint) {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999))
  const user = await prisma.user.create({
    data: { username: `h_${rid()}`, publicId, defaultPublicId: publicId, country: 'IN' },
  })
  const wallet = await prisma.wallet.create({ data: { userId: user.id, currencyType: 'POINT' } })
  await prisma.pointLedgerEntry.create({
    data: {
      walletId: wallet.id,
      direction: 'CREDIT',
      txType: 'ADJUSTMENT',
      amount: points,
      balanceAfter: points,
      idempotencyKey: `seed-${rid()}`,
    },
  })
  const method = await prisma.userPaymentMethod.create({
    data: { userId: user.id, methodType: 'EPAY', epayEmail: `${rid()}@example.invalid` },
  })
  return { user, wallet, method }
}

async function counts(userId: string, walletId: string) {
  const [withdrawals, debits] = await Promise.all([
    prisma.withdrawal.count({ where: { userId } }),
    prisma.pointLedgerEntry.count({ where: { walletId, txType: 'WITHDRAWAL' } }),
  ])
  return { withdrawals, debits }
}

describe('F04: withdrawal create idempotency survives the Redis marker', () => {
  it('concurrent creates with one key (Redis bypassed) make one withdrawal and one debit', async () => {
    const { user, wallet, method } = await makeHost(10_000_000n)
    const key = `k-${rid()}`
    const idem = `withdrawal-create:${user.id}:${key}`
    const params = { grossPoints: GROSS, paymentMethodId: method.id, idempotencyKey: key }

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        withdrawalService.executeCreateWithdrawal(user.id, params, idem),
      ),
    )
    const ok = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    expect(ok.length, JSON.stringify(results.filter((r) => r.status === 'rejected'))).toBe(5)
    expect(new Set(ok.map((r) => r.withdrawalId)).size).toBe(1)
    expect(await counts(user.id, wallet.id)).toEqual({ withdrawals: 1, debits: 1 })
  })

  it('a late retry after the Redis marker is gone returns the same withdrawal, no new debit', async () => {
    const { user, wallet, method } = await makeHost(10_000_000n)
    const key = `k-${rid()}`
    const params = { grossPoints: GROSS, paymentMethodId: method.id, idempotencyKey: key }

    const first = await withdrawalService.createWithdrawal(user.id, params)
    // The marker is deleted on any error (even after the commit) and expires: simulate both.
    await redisClient.del(RedisKeys.walletIdem(`withdrawal-create:${user.id}:${key}`))
    const again = (await withdrawalService.createWithdrawal(user.id, params)) as typeof first

    expect(again.withdrawalId).toBe(first.withdrawalId)
    expect(again.grossPoints).toBe(GROSS.toString())
    expect(await counts(user.id, wallet.id)).toEqual({ withdrawals: 1, debits: 1 })
  })

  it('a different key is a different withdrawal', async () => {
    const { user, wallet, method } = await makeHost(10_000_000n)
    const base = { grossPoints: GROSS, paymentMethodId: method.id }
    const a = await withdrawalService.createWithdrawal(user.id, { ...base, idempotencyKey: `k-${rid()}` })
    const b = await withdrawalService.createWithdrawal(user.id, { ...base, idempotencyKey: `k-${rid()}` })
    expect(a.withdrawalId).not.toBe(b.withdrawalId)
    expect(await counts(user.id, wallet.id)).toEqual({ withdrawals: 2, debits: 2 })
  })
})
