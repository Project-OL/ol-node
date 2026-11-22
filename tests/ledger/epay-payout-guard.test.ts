/**
 * Epay payout money-safety on a REAL Postgres (env.setup.ts throwaway DB):
 *  - an in-flight Epay payout blocks a refund (adminReverseWithdrawal / points-freeze cancel)
 *  - a payout moves the withdrawal PENDING_PLATFORM → WAITING exactly once
 *  - concurrent "Pay via Epay" clicks send one transfer
 *  - "pay" racing "refund" on one withdrawal: never both
 * Only the Epay HTTP client and outbound queues are stubbed.
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
  withdrawalPayoutRailConfigService: { assertRailEnabled: vi.fn().mockResolvedValue(undefined) },
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

const createEpayTransfer = vi.fn()
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return {
    ...actual,
    isEpayConfigured: () => true,
    epayGateway: {
      createEpayTransfer: (...a: unknown[]) => createEpayTransfer(...a),
      queryPayout: vi.fn(),
    },
  }
})

import { prisma } from '../../src/config/database'
import { redisClient } from '../../src/config/redis'
import { withdrawalService } from '../../src/services/withdrawal.service'
import { epayPayoutService } from '../../src/services/epay-payout.service'

const rid = () => randomBytes(6).toString('hex')
const GROSS = 200_000n
const ADMIN = 'ledger-test-admin'

afterAll(async () => {
  await prisma.$disconnect()
  redisClient.disconnect()
})

beforeAll(async () => {
  await prisma.payrollConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} })
})

beforeEach(() => {
  createEpayTransfer.mockReset()
})

async function epayWithdrawal() {
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
      amount: 10_000_000n,
      balanceAfter: 10_000_000n,
      idempotencyKey: `seed-${rid()}`,
    },
  })
  const method = await prisma.userPaymentMethod.create({
    data: { userId: user.id, methodType: 'EPAY', epayEmail: `${rid()}@example.invalid` },
  })
  const created = await withdrawalService.createWithdrawal(user.id, {
    grossPoints: GROSS,
    paymentMethodId: method.id,
    idempotencyKey: `k-${rid()}`,
  })
  const w = await prisma.withdrawal.findUniqueOrThrow({ where: { id: created.withdrawalId } })
  expect(w.status).toBe('PENDING_PLATFORM')
  expect(w.hostPayoutUsd?.gt(0)).toBe(true)
  return { user, wallet, method, w }
}

const refunds = (walletId: string) =>
  prisma.pointLedgerEntry.count({ where: { walletId, txType: 'WITHDRAWAL_REFUND' } })

async function liveAttempt(withdrawalId: string, status = 'SUBMITTED') {
  return prisma.epayPayoutOrder.create({
    data: {
      withdrawalId,
      merchantOrderNo: `WD261120${rid().toUpperCase()}${rid().toUpperCase().slice(0, 4)}`,
      receiveEpayAccount: 'x@example.invalid',
      amount: '1.00',
      status,
    },
  })
}

describe('Epay payout guard (real Postgres)', () => {
  it('an in-flight payout blocks the refund; once Epay says FAILED the refund goes through', async () => {
    const { w, wallet } = await epayWithdrawal()
    const attempt = await liveAttempt(w.id, 'UNKNOWN')

    await expect(
      withdrawalService.adminReverseWithdrawal(ADMIN, w.id, 'test'),
    ).rejects.toMatchObject({ statusCode: 409, code: 'EPAY_PAYOUT_IN_FLIGHT' })
    expect(await refunds(wallet.id)).toBe(0)
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe(
      'PENDING_PLATFORM',
    )

    await prisma.epayPayoutOrder.update({ where: { id: attempt.id }, data: { status: 'FAILED' } })
    await withdrawalService.adminReverseWithdrawal(ADMIN, w.id, 'test')
    expect(await refunds(wallet.id)).toBe(1)
    expect((await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })).status).toBe(
      'FAILED',
    )
  })

  it('points-freeze cancel skips (and reports) withdrawals with an in-flight payout', async () => {
    const { w, user, wallet } = await epayWithdrawal()
    await liveAttempt(w.id, 'SUBMITTED')
    const out = await withdrawalService.cancelUnsettledWithdrawalsForPointsFreeze(user.id, ADMIN)
    expect(out.cancelledIds).toEqual([])
    expect(out.skippedEpayInFlightIds).toEqual([w.id])
    expect(await refunds(wallet.id)).toBe(0)
  })

  it('manual "paid + proof" is refused while an Epay payout is in flight', async () => {
    const { w } = await epayWithdrawal()
    await liveAttempt(w.id, 'SUBMITTING')
    await expect(
      withdrawalService.adminCompletePlatformPayout(ADMIN, w.id, {
        proofS3Key: `payroll/proofs/platform/${w.id}/p.png`,
        proofS3Bucket: 'b',
      }),
    ).rejects.toMatchObject({ code: 'EPAY_PAYOUT_IN_FLIGHT' })
  })

  it('Pay via Epay: status 7 → payout SUCCESS, withdrawal WAITING with the Epay ref; a 2nd click is refused', async () => {
    const { w, method } = await epayWithdrawal()
    createEpayTransfer.mockResolvedValue({ status: '7', epayOrderNo: `EP${rid()}`, fee: '0.10' })

    const out = await epayPayoutService.payWithdrawalViaEpay(ADMIN, w.id)
    expect(out.status).toBe('SUCCESS')
    expect(createEpayTransfer).toHaveBeenCalledTimes(1)
    expect(createEpayTransfer.mock.calls[0][0]).toMatchObject({
      amount: w.hostPayoutUsd!.toFixed(2),
      currency: 'USD',
      receiveEpayAccount: method.epayEmail,
    })

    const after = await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })
    expect(after.status).toBe('WAITING')
    expect(after.payoutRef).toMatch(/^EPAY:EP/)
    const rows = await prisma.epayPayoutOrder.findMany({ where: { withdrawalId: w.id } })
    expect(rows.map((r) => r.status)).toEqual(['SUCCESS'])

    await expect(epayPayoutService.payWithdrawalViaEpay(ADMIN, w.id)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    })
    expect(createEpayTransfer).toHaveBeenCalledTimes(1)
  })

  it('5 concurrent "Pay via Epay" clicks send exactly one transfer', async () => {
    const { w } = await epayWithdrawal()
    createEpayTransfer.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 150))
      return { status: '1', epayOrderNo: `EP${rid()}` }
    })
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => epayPayoutService.payWithdrawalViaEpay(ADMIN, w.id)),
    )
    expect(createEpayTransfer).toHaveBeenCalledTimes(1)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'EPAY_PAYOUT_EXISTS' })
    }
    const rows = await prisma.epayPayoutOrder.findMany({ where: { withdrawalId: w.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('SUBMITTED')
  })

  it('DB blip after Epay paid: refund is refused, and the reconcile repair moves it to WAITING', async () => {
    const { w, wallet } = await epayWithdrawal()
    // Simulate: Epay confirmed (attempt SUCCESS) but the withdrawal step never ran.
    await prisma.epayPayoutOrder.create({
      data: {
        withdrawalId: w.id,
        merchantOrderNo: `WD261122${rid().toUpperCase()}${rid().toUpperCase().slice(0, 4)}`,
        epayOrderNo: `EP${rid()}`,
        receiveEpayAccount: 'x@example.invalid',
        amount: w.hostPayoutUsd!,
        status: 'SUCCESS',
        completedAt: new Date(),
      },
    })

    await expect(withdrawalService.adminReverseWithdrawal(ADMIN, w.id, 'test')).rejects.toMatchObject({
      code: 'EPAY_PAYOUT_ALREADY_SENT',
    })
    expect(await refunds(wallet.id)).toBe(0)

    expect(await epayPayoutService.repairUnfinalizedSuccesses()).toBeGreaterThanOrEqual(1)
    const after = await prisma.withdrawal.findUniqueOrThrow({ where: { id: w.id } })
    expect(after.status).toBe('WAITING')
    expect(after.payoutRef).toMatch(/^EPAY:EP/)
  })

  it('connection refused on the transfer → attempt FAILED at once, and a retry is allowed', async () => {
    const { EpayUnavailableError } = await import('../../src/lib/epay/epay-gateway.client')
    const { w } = await epayWithdrawal()
    createEpayTransfer.mockRejectedValueOnce(new EpayUnavailableError('/c', 'ECONNREFUSED', 'NOT_SENT'))
    const first = await epayPayoutService.payWithdrawalViaEpay(ADMIN, w.id)
    expect(first.status).toBe('FAILED')

    createEpayTransfer.mockResolvedValueOnce({ status: '7', epayOrderNo: `EP${rid()}` })
    const second = await epayPayoutService.payWithdrawalViaEpay(ADMIN, w.id)
    expect(second.status).toBe('SUCCESS')
    const rows = await prisma.epayPayoutOrder.findMany({
      where: { withdrawalId: w.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(rows.map((r) => r.status)).toEqual(['FAILED', 'SUCCESS'])
  })

  it('"pay" racing "refund": never both a transfer and a refund', async () => {
    for (let i = 0; i < 5; i++) {
      const { w, wallet } = await epayWithdrawal()
      createEpayTransfer.mockResolvedValue({ status: '1', epayOrderNo: `EP${rid()}` })
      createEpayTransfer.mockClear()
      await Promise.allSettled([
        epayPayoutService.payWithdrawalViaEpay(ADMIN, w.id),
        withdrawalService.adminReverseWithdrawal(ADMIN, w.id, 'race'),
      ])
      const sent = createEpayTransfer.mock.calls.length
      const refunded = await refunds(wallet.id)
      expect(sent + refunded, `iteration ${i}: sent=${sent} refunded=${refunded}`).toBe(1)
    }
  })
})
