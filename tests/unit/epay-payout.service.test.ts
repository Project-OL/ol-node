import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const env: Record<string, unknown> = { EPAY_PAYOUT_ENABLED: true }
vi.mock('../../src/config/env', () => ({ env }))

const payoutCreate = vi.fn()
const payoutCount = vi.fn()
const payoutFindMany = vi.fn()
const withdrawalFindMany = vi.fn()
const payoutUpdateMany = vi.fn()
const payoutFindUnique = vi.fn()
const payoutFindUniqueOrThrow = vi.fn()
const withdrawalFindUnique = vi.fn()
const methodFindUnique = vi.fn()
const queryRaw = vi.fn()
vi.mock('../../src/config/database', () => {
  const tx = {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    withdrawal: { findUnique: (...a: unknown[]) => withdrawalFindUnique(...a) },
    userPaymentMethod: { findUnique: (...a: unknown[]) => methodFindUnique(...a) },
    epayPayoutOrder: {
      create: (...a: unknown[]) => payoutCreate(...a),
      count: (...a: unknown[]) => payoutCount(...a),
    },
  }
  return {
    prisma: {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      withdrawal: { findMany: (...a: unknown[]) => withdrawalFindMany(...a) },
      epayPayoutOrder: {
        findMany: (...a: unknown[]) => payoutFindMany(...a),
        updateMany: (...a: unknown[]) => payoutUpdateMany(...a),
        findUnique: (...a: unknown[]) => payoutFindUnique(...a),
        findUniqueOrThrow: (...a: unknown[]) => payoutFindUniqueOrThrow(...a),
      },
    },
  }
})

const createEpayTransfer = vi.fn()
const queryPayout = vi.fn()
const epayEnabled = vi.fn(() => true)
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return {
    classifyEpayStatus: actual.classifyEpayStatus,
    EpayRejectedError: actual.EpayRejectedError,
    EpayUnavailableError: actual.EpayUnavailableError,
    isDefinitelyNotSent: actual.isDefinitelyNotSent,
    isEpayConfigured: () => epayEnabled(),
    epayGateway: {
      createEpayTransfer: (...a: unknown[]) => createEpayTransfer(...a),
      queryPayout: (...a: unknown[]) => queryPayout(...a),
    },
  }
})

const markSent = vi.fn()
vi.mock('../../src/services/withdrawal.service', () => ({
  EPAY_PAYOUT_LIVE_STATUSES: ['SUBMITTING', 'SUBMITTED', 'UNKNOWN'],
  isPlatformHandledWithdrawal: (w: { methodType?: string; payoutHandler?: string }) =>
    w.payoutHandler === 'PLATFORM' || w.methodType === 'EPAY',
  withdrawalService: {
    markPlatformPayoutSentViaEpay: (...a: unknown[]) => markSent(...a),
  },
}))
vi.mock('../../src/services/audit.service', () => ({ auditService: { logAdmin: vi.fn() } }))
vi.mock('../../src/utils/rootLogger', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { rootLogger: { child: () => l } }
})

const { epayPayoutService } = await import('../../src/services/epay-payout.service')
const { EpayRejectedError, EpayUnavailableError } = await import(
  '../../src/lib/epay/epay-gateway.client'
)

const W = '11111111-1111-4111-8111-111111111111'
const withdrawal = (over: Record<string, unknown> = {}) => ({
  id: W,
  status: 'PENDING_PLATFORM',
  methodType: 'EPAY',
  payoutHandler: 'PLATFORM',
  hostPayoutUsd: new Prisma.Decimal('12.50'),
  paymentMethodId: 'pm-1',
  ...over,
})
const payoutRow = (over: Record<string, unknown> = {}) => ({
  id: 'po-1',
  withdrawalId: W,
  merchantOrderNo: 'WD261120ABCDEF0123456789',
  epayOrderNo: null,
  receiveEpayAccount: 'host@example.test',
  amount: new Prisma.Decimal('12.50'),
  currency: 'USD',
  status: 'SUBMITTING',
  requestedByAdminId: 'admin-1',
  createdAt: new Date(Date.now() - 5 * 60_000),
  ...over,
})

describe('epayPayoutService.payWithdrawalViaEpay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    env.EPAY_PAYOUT_ENABLED = true
    epayEnabled.mockReturnValue(true)
    withdrawalFindUnique.mockResolvedValue(withdrawal())
    methodFindUnique.mockResolvedValue({ epayEmail: 'host@example.test' })
    payoutCount.mockResolvedValue(0)
    payoutCreate.mockImplementation(async ({ data }) => payoutRow({ merchantOrderNo: data.merchantOrderNo }))
    payoutUpdateMany.mockResolvedValue({ count: 1 })
    payoutFindUniqueOrThrow.mockImplementation(async () => payoutRow({ status: 'SUCCESS', epayOrderNo: 'EP-1' }))
    markSent.mockResolvedValue(true)
  })

  it('refuses while EPAY_PAYOUT_ENABLED is off (no DB write, no Epay call)', async () => {
    env.EPAY_PAYOUT_ENABLED = false
    await expect(epayPayoutService.payWithdrawalViaEpay('admin-1', W)).rejects.toMatchObject({
      code: 'EPAY_PAYOUT_DISABLED',
    })
    expect(payoutCreate).not.toHaveBeenCalled()
    expect(createEpayTransfer).not.toHaveBeenCalled()
  })

  it('locks the withdrawal row, records the attempt, sends hostPayoutUsd once; 7 → withdrawal WAITING', async () => {
    createEpayTransfer.mockResolvedValue({ status: '7', epayOrderNo: 'EP-1', fee: '0.60' })
    const out = await epayPayoutService.payWithdrawalViaEpay('admin-1', W)
    expect(queryRaw).toHaveBeenCalledTimes(1) // FOR UPDATE
    const created = payoutCreate.mock.calls[0][0].data
    expect(created).toMatchObject({
      withdrawalId: W,
      receiveEpayAccount: 'host@example.test',
      currency: 'USD',
      status: 'SUBMITTING',
    })
    expect(created.amount.toFixed(2)).toBe('12.50')
    expect(createEpayTransfer).toHaveBeenCalledTimes(1)
    expect(createEpayTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ amount: '12.50', currency: 'USD', receiveEpayAccount: 'host@example.test' }),
    )
    expect(markSent).toHaveBeenCalledWith(W, expect.objectContaining({ payoutRef: 'EPAY:EP-1' }))
    expect(out.status).toBe('SUCCESS')
  })

  it.each([
    [{ status: 'WAITING' }, 'INVALID_STATE'],
    [{ methodType: 'BANK', payoutHandler: 'AGENCY' }, 'NOT_EPAY_WITHDRAWAL'],
    [{ hostPayoutUsd: null }, 'NO_PAYOUT_AMOUNT'],
    [{ hostPayoutUsd: new Prisma.Decimal(0) }, 'NO_PAYOUT_AMOUNT'],
  ])('refuses %o with %s before any Epay call', async (over, code) => {
    withdrawalFindUnique.mockResolvedValue(withdrawal(over))
    await expect(epayPayoutService.payWithdrawalViaEpay('admin-1', W)).rejects.toMatchObject({ code })
    expect(createEpayTransfer).not.toHaveBeenCalled()
  })

  it('refuses when the host has no Epay account', async () => {
    methodFindUnique.mockResolvedValue({ epayEmail: null })
    await expect(epayPayoutService.payWithdrawalViaEpay('admin-1', W)).rejects.toMatchObject({
      code: 'NO_EPAY_ACCOUNT',
    })
    expect(createEpayTransfer).not.toHaveBeenCalled()
  })

  it('an existing non-FAILED attempt (checked under the row lock) → 409, nothing created or sent', async () => {
    payoutCount.mockResolvedValue(1)
    await expect(epayPayoutService.payWithdrawalViaEpay('admin-1', W)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EPAY_PAYOUT_EXISTS',
    })
    expect(payoutCount).toHaveBeenCalledWith({
      where: { withdrawalId: W, status: { not: 'FAILED' } },
    })
    expect(payoutCreate).not.toHaveBeenCalled()
    expect(createEpayTransfer).not.toHaveBeenCalled()
  })

  it('a second live attempt (DB partial unique index) → 409, nothing sent', async () => {
    payoutCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 't' }),
    )
    await expect(epayPayoutService.payWithdrawalViaEpay('admin-1', W)).rejects.toMatchObject({
      statusCode: 409,
      code: 'EPAY_PAYOUT_EXISTS',
    })
    expect(createEpayTransfer).not.toHaveBeenCalled()
  })

  it('Epay rejection → FAILED (retry allowed), withdrawal untouched', async () => {
    createEpayTransfer.mockRejectedValue(new EpayRejectedError('/c', 0, 'insufficient balance'))
    const out = await epayPayoutService.payWithdrawalViaEpay('admin-1', W)
    expect(out.status).toBe('FAILED')
    expect(payoutUpdateMany.mock.calls[0][0].data.status).toBe('FAILED')
    expect(markSent).not.toHaveBeenCalled()
  })

  it('timeout → UNKNOWN, never resent, withdrawal untouched', async () => {
    createEpayTransfer.mockRejectedValue(new EpayUnavailableError('/c', 'timeout'))
    const out = await epayPayoutService.payWithdrawalViaEpay('admin-1', W)
    expect(out.status).toBe('UNKNOWN')
    expect(createEpayTransfer).toHaveBeenCalledTimes(1)
    expect(payoutUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'po-1', status: { in: ['SUBMITTING', 'SUBMITTED', 'UNKNOWN'] } },
      data: { status: 'UNKNOWN' },
    })
    expect(markSent).not.toHaveBeenCalled()
  })

  it('connection refused / 4xx (never reached Epay) → FAILED right away, safe to retry', async () => {
    createEpayTransfer.mockRejectedValue(new EpayUnavailableError('/c', 'ECONNREFUSED', 'NOT_SENT'))
    const out = await epayPayoutService.payWithdrawalViaEpay('admin-1', W)
    expect(out.status).toBe('FAILED')
    expect(out.failureReason).toMatch(/^NOT_SENT/)
    expect(payoutUpdateMany.mock.calls[0][0].data.status).toBe('FAILED')
    expect(markSent).not.toHaveBeenCalled()
  })

  it('circuit open (Epay down, call skipped) → FAILED, not UNKNOWN', async () => {
    const { AppError } = await import('../../src/middlewares/errorHandler')
    createEpayTransfer.mockRejectedValue(new AppError(502, 'open', 'EPAY_CIRCUIT_OPEN'))
    const out = await epayPayoutService.payWithdrawalViaEpay('admin-1', W)
    expect(out.status).toBe('FAILED')
    expect(createEpayTransfer).toHaveBeenCalledTimes(1)
  })

  it('non-final status → SUBMITTED; the reconcile job finishes it', async () => {
    createEpayTransfer.mockResolvedValue({ status: '1', epayOrderNo: 'EP-1' })
    const out = await epayPayoutService.payWithdrawalViaEpay('admin-1', W)
    expect(out.status).toBe('SUBMITTED')
    expect(markSent).not.toHaveBeenCalled()
  })
})

describe('epayPayoutService.settlePayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    epayEnabled.mockReturnValue(true)
    payoutUpdateMany.mockResolvedValue({ count: 1 })
    markSent.mockResolvedValue(true)
  })

  it('UNKNOWN + Epay says 7 → SUCCESS and the withdrawal moves on', async () => {
    payoutFindUnique.mockResolvedValue(payoutRow({ status: 'UNKNOWN' }))
    payoutFindUniqueOrThrow.mockResolvedValue(payoutRow({ status: 'SUCCESS', epayOrderNo: 'EP-2' }))
    queryPayout.mockResolvedValue({ status: '7', epayOrderNo: 'EP-2', amount: '12.50' })
    expect(await epayPayoutService.settlePayout('WD261120ABCDEF0123456789', 'reconcile')).toBe('SUCCESS')
    expect(markSent).toHaveBeenCalledWith(W, expect.objectContaining({ payoutRef: 'EPAY:EP-2' }))
  })

  it('Epay final failure → FAILED, withdrawal untouched (admin may retry or refund)', async () => {
    payoutFindUnique.mockResolvedValue(payoutRow({ status: 'SUBMITTED' }))
    queryPayout.mockResolvedValue({ status: '6' })
    expect(await epayPayoutService.settlePayout('WD261120ABCDEF0123456789', 'callback')).toBe('FAILED')
    expect(markSent).not.toHaveBeenCalled()
  })

  it('"no such order" only closes the attempt after the grace period', async () => {
    queryPayout.mockRejectedValue(new EpayRejectedError('/q', 0, 'not exist'))
    payoutFindUnique.mockResolvedValue(payoutRow({ status: 'UNKNOWN' }))
    expect(await epayPayoutService.settlePayout('WD261120ABCDEF0123456789', 'reconcile')).toBe('PENDING')
    payoutFindUnique.mockResolvedValue(
      payoutRow({ status: 'UNKNOWN', createdAt: new Date(Date.now() - 60 * 60_000) }),
    )
    expect(await epayPayoutService.settlePayout('WD261120ABCDEF0123456789', 'reconcile')).toBe('FAILED')
  })

  it('SUCCESS row re-runs the idempotent withdrawal step (crash repair), no query', async () => {
    payoutFindUnique.mockResolvedValue(payoutRow({ status: 'SUCCESS', epayOrderNo: 'EP-3' }))
    expect(await epayPayoutService.settlePayout('WD261120ABCDEF0123456789', 'callback')).toBe(
      'ALREADY_FINAL',
    )
    expect(queryPayout).not.toHaveBeenCalled()
    expect(markSent).toHaveBeenCalledTimes(1)
  })

  it('repairUnfinalizedSuccesses: paid at Epay but withdrawal still PENDING_PLATFORM → finalized', async () => {
    payoutFindMany.mockResolvedValue([
      payoutRow({ status: 'SUCCESS', epayOrderNo: 'EP-9', withdrawalId: W }),
      payoutRow({ id: 'po-2', status: 'SUCCESS', withdrawalId: 'other-w' }),
    ])
    withdrawalFindMany.mockResolvedValue([{ id: W }])
    expect(await epayPayoutService.repairUnfinalizedSuccesses()).toBe(1)
    expect(markSent).toHaveBeenCalledTimes(1)
    expect(markSent).toHaveBeenCalledWith(W, expect.objectContaining({ payoutRef: 'EPAY:EP-9' }))
  })

  it('FAILED rows are left alone', async () => {
    payoutFindUnique.mockResolvedValue(payoutRow({ status: 'FAILED' }))
    expect(await epayPayoutService.settlePayout('WD261120ABCDEF0123456789', 'callback')).toBe(
      'ALREADY_FINAL',
    )
    expect(queryPayout).not.toHaveBeenCalled()
    expect(markSent).not.toHaveBeenCalled()
  })
})
