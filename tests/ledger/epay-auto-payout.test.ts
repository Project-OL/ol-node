/**
 * Automatic Epay payouts on a REAL Postgres (env.setup.ts throwaway DB). Only the Epay HTTP
 * client and outbound queues are stubbed.
 *  - OFF (default) pays nothing
 *  - eligible withdrawals are paid oldest first through the guarded payout path
 *  - rules skip: Epay email changed < hold, above single limit, suspect list, points frozen,
 *    suspended account, per-user 24 h cap; platform cap / low balance stop the run
 *  - two overlapping runs never pay one withdrawal twice
 */
import { randomBytes } from 'crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.EPAY_PAYOUT_ENABLED = 'true'
})

vi.mock('../../src/repositories/faceVerification.repository', () => ({
  faceVerificationRepository: { isIndexedForUser: vi.fn().mockResolvedValue(true) },
}))
vi.mock('../../src/services/withdrawalPayoutRailConfig.service', () => ({
  withdrawalPayoutRailConfigService: {
    assertRailEnabled: vi.fn().mockResolvedValue(undefined),
    getPublicConfig: vi.fn(async () => ({ epay: { minWithdrawalUsd: 1 } })),
  },
}))
vi.mock('../../src/queues/platform-message.queue', () => ({
  enqueuePlatformWithdrawalMessage: vi.fn().mockResolvedValue(undefined),
  enqueuePlatformLedgerMessage: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/queues/payroll.queue', () => ({
  payrollSlaQueue: {},
  msUntil: () => 0,
  enqueuePayrollSla: vi.fn(),
  removePayrollSla: vi.fn(),
  enqueuePayrollWaiting: vi.fn(),
  removePayrollWaiting: vi.fn(),
  enqueuePlatformWaiting: vi.fn(),
  removePlatformWaiting: vi.fn(),
}))
const alert = vi.fn()
vi.mock('../../src/services/payment-attention.service', () => ({
  paymentAttentionService: { alert: (...a: unknown[]) => alert(...a) },
}))

const createEpayTransfer = vi.fn()
const getBalance = vi.fn()
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return {
    ...actual,
    isEpayConfigured: () => true,
    epayGateway: {
      createEpayTransfer: (...a: unknown[]) => createEpayTransfer(...a),
      getBalance: (...a: unknown[]) => getBalance(...a),
      queryPayout: vi.fn(),
    },
  }
})

import { prisma } from '../../src/config/database'
import { redisClient } from '../../src/config/redis'
import { withdrawalService } from '../../src/services/withdrawal.service'
import { epayAutoPayoutService } from '../../src/services/epay-auto-payout.service'

const rid = () => randomBytes(6).toString('hex')
const DAY = 86_400_000

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

beforeAll(async () => {
  await prisma.payrollConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
})

beforeEach(async () => {
  createEpayTransfer.mockReset()
  createEpayTransfer.mockImplementation(async (p: { merchantOrderNo: string; amount: string }) => ({
    merchantOrderNo: p.merchantOrderNo,
    epayOrderNo: `EP-${rid()}`,
    status: '7',
    amount: p.amount,
    fee: '0.29',
  }))
  getBalance.mockReset()
  getBalance.mockResolvedValue({ currency: 'USD', balance: '1000000' })
  alert.mockReset()
  // Isolate from other suites: only this test's withdrawals are queued.
  await prisma.withdrawal.updateMany({
    where: { status: 'PENDING_PLATFORM' },
    data: { status: 'FAILED', failReason: 'test isolation' },
  })
  // Earlier payouts (this and other suites) leave the rolling 24 h window.
  await prisma.$executeRaw`UPDATE epay_payout_orders SET created_at = created_at - interval '2 days'`
  await redisClient.del('epay:auto-payout:low-balance-alerted').catch(() => {})
  await prisma.epayAutoPayoutConfig.upsert({
    where: { id: 1 },
    create: { id: 1, enabled: true },
    update: {
      enabled: true,
      maxSinglePayoutUsd: 5000,
      userDailyCapUsd: 10000,
      platformDailyCapUsd: 50000,
      emailChangeHoldHours: 48,
      minBalanceBufferUsd: 0,
      feeReserveUsd: 1,
    },
  })
})

/** An EPAY withdrawal of `usd` (gross) by a fresh user; email bound `emailAgeMs` ago. */
async function queued(usd: number, opts: { emailAgeMs?: number } = {}) {
  const publicId = BigInt(10_000_000 + Math.floor(Math.random() * 89_999_999))
  const user = await prisma.user.create({
    data: {
      username: `ap_${rid()}`,
      publicId,
      defaultPublicId: publicId,
      country: 'IN',
      status: 'active',
      isAgent: true,
    },
  })
  const wallet = await prisma.wallet.create({ data: { userId: user.id, currencyType: 'POINT' } })
  await prisma.pointLedgerEntry.create({
    data: {
      walletId: wallet.id,
      direction: 'CREDIT',
      txType: 'ADJUSTMENT',
      amount: 1_000_000_000n,
      balanceAfter: 1_000_000_000n,
      idempotencyKey: `seed-${rid()}`,
    },
  })
  const method = await prisma.userPaymentMethod.create({
    data: {
      userId: user.id,
      methodType: 'EPAY',
      epayEmail: `${rid()}@example.invalid`,
      epayEmailChangedAt: new Date(Date.now() - (opts.emailAgeMs ?? 3 * DAY)),
    },
  })
  const created = await withdrawalService.createWithdrawal(user.id, {
    grossPoints: BigInt(usd * 10_000),
    paymentMethodId: method.id,
    idempotencyKey: `k-${rid()}`,
  })
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id: created.withdrawalId } })
  expect(w.status).toBe('PENDING_PLATFORM')
  return { user, w }
}

const statusOf = async (id: string) =>
  (await prisma.withdrawal.findUniqueOrThrow({ where: { id } })).status

describe('automatic Epay payouts (real Postgres)', () => {
  it('OFF pays nothing', async () => {
    await prisma.epayAutoPayoutConfig.update({ where: { id: 1 }, data: { enabled: false } })
    const a = await queued(1000)
    const run = await epayAutoPayoutService.runOnce()
    expect(run.stoppedBy).toBe('DISABLED')
    expect(createEpayTransfer).not.toHaveBeenCalled()
    expect(await statusOf(a.w.id)).toBe('PENDING_PLATFORM')
  })

  it('pays eligible withdrawals oldest first and skips the ones a rule holds back', async () => {
    const ok1 = await queued(1000)
    const recentEmail = await queued(1000, { emailAgeMs: 60 * 60 * 1000 })
    const tooBig = await queued(6000)
    const suspect = await queued(1000)
    await prisma.paymentSuspect.create({
      data: {
        identityType: 'USER',
        identityValue: suspect.user.id,
        userId: suspect.user.id,
        reason: 'PAYMENT_REFUND',
      },
    })
    const frozen = await queued(1000)
    await prisma.user.update({ where: { id: frozen.user.id }, data: { pointsFrozen: true } })
    const ok2 = await queued(1500)

    const run = await epayAutoPayoutService.runOnce()
    expect(run.stoppedBy).toBeNull()
    expect(run.paid.map((p) => p.withdrawalId)).toEqual([ok1.w.id, ok2.w.id])
    expect(run.paid.every((p) => p.status === 'SUCCESS')).toBe(true)
    const reasons = Object.fromEntries(run.skipped.map((s) => [s.withdrawalId, s.reason]))
    expect(reasons).toEqual({
      [recentEmail.w.id]: 'EMAIL_RECENTLY_CHANGED',
      [tooBig.w.id]: 'ABOVE_SINGLE_LIMIT',
      [suspect.w.id]: 'SUSPECT_LIST',
      [frozen.w.id]: 'POINTS_FROZEN',
    })
    expect(await statusOf(ok1.w.id)).toBe('WAITING')
    expect(await statusOf(ok2.w.id)).toBe('WAITING')
    expect(await statusOf(tooBig.w.id)).toBe('PENDING_PLATFORM')
    expect(createEpayTransfer).toHaveBeenCalledTimes(2)
  })

  it('low balance stops the run, keeps oldest-first order, alerts once', async () => {
    getBalance.mockResolvedValue({ currency: 'USD', balance: '500.00' })
    const big = await queued(1000)
    const small = await queued(100)
    const run = await epayAutoPayoutService.runOnce()
    expect(run.stoppedBy).toBe('LOW_BALANCE')
    expect(createEpayTransfer).not.toHaveBeenCalled() // the younger, smaller one does not jump
    expect(await statusOf(big.w.id)).toBe('PENDING_PLATFORM')
    expect(await statusOf(small.w.id)).toBe('PENDING_PLATFORM')
    await epayAutoPayoutService.runOnce()
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('per-user and platform 24 h caps', async () => {
    await prisma.epayAutoPayoutConfig.update({
      where: { id: 1 },
      data: { userDailyCapUsd: 1500, platformDailyCapUsd: 2600 },
    })
    const a1 = await queued(1000)
    const b = await queued(1000)
    // second withdrawal by the SAME user as a1
    const method = await prisma.userPaymentMethod.findFirstOrThrow({ where: { userId: a1.user.id } })
    const a2 = await withdrawalService.createWithdrawal(a1.user.id, {
      grossPoints: 10_000_000n,
      paymentMethodId: method.id,
      idempotencyKey: `k-${rid()}`,
    })
    const c = await queued(1000)

    const run = await epayAutoPayoutService.runOnce()
    expect(run.paid.map((p) => p.withdrawalId)).toEqual([a1.w.id, b.w.id])
    expect(run.skipped).toEqual([
      expect.objectContaining({ withdrawalId: a2.withdrawalId, reason: 'USER_DAILY_CAP' }),
    ])
    expect(run.stoppedBy).toBe('PLATFORM_DAILY_CAP') // c would take the platform past 2,600
    expect(await statusOf(c.w.id)).toBe('PENDING_PLATFORM')
  })

  it('two overlapping runs pay each withdrawal once', async () => {
    const ws = await Promise.all([queued(1000), queued(1000), queued(1000)])
    await Promise.all([epayAutoPayoutService.runOnce(), epayAutoPayoutService.runOnce()])
    expect(createEpayTransfer).toHaveBeenCalledTimes(3)
    for (const x of ws) {
      expect(await statusOf(x.w.id)).toBe('WAITING')
      expect(
        await prisma.epayPayoutOrder.count({ where: { withdrawalId: x.w.id, status: 'SUCCESS' } }),
      ).toBe(1)
    }
  })
})
