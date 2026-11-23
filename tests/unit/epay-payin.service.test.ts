import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const personalFindUnique = vi.fn()
const personalUpdateMany = vi.fn()
const tradingFindUnique = vi.fn()
const tradingUpdateMany = vi.fn()
vi.mock('../../src/config/database', () => ({
  prisma: {
    coinTopupOrder: {
      findUnique: (...a: unknown[]) => personalFindUnique(...a),
      updateMany: (...a: unknown[]) => personalUpdateMany(...a),
    },
    coinTradingTopupOrder: {
      findUnique: (...a: unknown[]) => tradingFindUnique(...a),
      updateMany: (...a: unknown[]) => tradingUpdateMany(...a),
    },
  },
}))

const queryPayin = vi.fn()
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return {
    classifyEpayStatus: actual.classifyEpayStatus,
    EpayRejectedError: actual.EpayRejectedError,
    EpayUnavailableError: actual.EpayUnavailableError,
    EPAY_CODE: actual.EPAY_CODE,
    epayCodeOf: actual.epayCodeOf,
    isEpayConfigured: () => true,
    epayGateway: { queryPayin: (...a: unknown[]) => queryPayin(...a) },
  }
})

const creditPersonal = vi.fn()
vi.mock('../../src/services/coin-wallet.service', () => ({
  coinWalletService: { creditPaidTopup: (...a: unknown[]) => creditPersonal(...a) },
}))
const creditTrading = vi.fn()
vi.mock('../../src/services/coinTrading.service', () => ({
  coinTradingService: { creditPaidTopup: (...a: unknown[]) => creditTrading(...a) },
}))
const redisSet = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: { set: (...a: unknown[]) => redisSet(...a) },
  RedisKeys: { epayQueryGate: (no: string) => `epay:qgate:${no}` },
}))
vi.mock('../../src/utils/rootLogger', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { rootLogger: { child: () => l } }
})

const { epayPayinService, checkPaidMatchesOrder, acquireEpayQueryGate } = await import(
  '../../src/services/epay-payin.service'
)
const { EpayRejectedError, EpayUnavailableError } = await import(
  '../../src/lib/epay/epay-gateway.client'
)

const CP = 'CP261120ABCDEF0123456789'
const CT = 'CT261120ABCDEF0123456789'
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

const personalOrder = (over: Record<string, unknown> = {}) => ({
  id: 'ord-1',
  status: 'PENDING',
  createdAt: minutesAgo(5),
  priceCents: 299,
  currency: 'USD',
  ...over,
})

describe('epayPayinService.settlePayin', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    personalFindUnique.mockResolvedValue(personalOrder())
    personalUpdateMany.mockResolvedValue({ count: 1 })
    tradingUpdateMany.mockResolvedValue({ count: 1 })
    creditPersonal.mockResolvedValue({ ledgerEntryId: 'l1' })
    creditTrading.mockResolvedValue(true)
  })

  it('status 7 with matching order/amount/currency → credits once with the paid fields', async () => {
    queryPayin.mockResolvedValue({
      merchantOrderNo: CP,
      epayOrderNo: 'EP-9',
      status: '7',
      amount: '2.99',
      currency: 'USD',
    })
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('CREDITED')
    expect(queryPayin).toHaveBeenCalledWith(CP)
    expect(creditPersonal).toHaveBeenCalledTimes(1)
    const [orderId, paid] = creditPersonal.mock.calls[0]
    expect(orderId).toBe('ord-1')
    expect(paid).toMatchObject({ epayOrderNo: 'EP-9', epayStatus: '7', paidCurrency: 'USD' })
    expect(paid.paidAmount.toFixed(2)).toBe('2.99')
  })

  it('"2.990" equals 2.99 (Decimal compare, not string/float)', async () => {
    queryPayin.mockResolvedValue({ status: '7', amount: '2.990', currency: 'usd' })
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('CREDITED')
  })

  it.each([
    [{ status: '7', amount: '0.01', currency: 'USD' }, /^AMOUNT_MISMATCH/],
    [{ status: '7', amount: '2.99', currency: 'EUR' }, /^CURRENCY_MISMATCH/],
    [{ status: '7', currency: 'USD' }, /^PAID_AMOUNT_OR_CURRENCY_MISSING/],
    [{ status: '7', amount: '2.99', currency: 'USD', merchantOrderNo: CT }, /^ORDER_NO_MISMATCH/],
  ])('status 7 but %o → REVIEW, never credited', async (data, reason) => {
    queryPayin.mockResolvedValue(data)
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('REVIEW')
    expect(creditPersonal).not.toHaveBeenCalled()
    const call = personalUpdateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'ord-1', status: { in: ['PENDING'] } })
    expect(call.data.status).toBe('REVIEW')
    expect(call.data.failureReason).toMatch(reason)
  })

  it.each(['5', '6', '8', '20'])('final failure status %s → FAILED, no credit', async (s) => {
    queryPayin.mockResolvedValue({ status: s })
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('FAILED')
    expect(personalUpdateMany.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      epayStatus: s,
    })
    expect(creditPersonal).not.toHaveBeenCalled()
  })

  it('non-final status stays PENDING (touch only); EXPIRED after 24 h', async () => {
    queryPayin.mockResolvedValue({ status: '0' })
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('PENDING')
    expect(personalUpdateMany.mock.calls[0][0].data.status).toBeUndefined()

    personalFindUnique.mockResolvedValue(personalOrder({ createdAt: minutesAgo(25 * 60) }))
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('EXPIRED')
    expect(creditPersonal).not.toHaveBeenCalled()
  })

  it('Epay "no such order" (1013): PENDING inside the grace period, FAILED after it', async () => {
    queryPayin.mockRejectedValue(new EpayRejectedError('/q', 1013, 'The Order doesn`t exist'))
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('PENDING')
    personalFindUnique.mockResolvedValue(personalOrder({ createdAt: minutesAgo(45) }))
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('FAILED')
  })

  it('any other refusal (5000 System Error) never closes an order, however old', async () => {
    queryPayin.mockRejectedValue(new EpayRejectedError('/q', 5000, 'System Error'))
    personalFindUnique.mockResolvedValue(personalOrder({ createdAt: minutesAgo(45) }))
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('PENDING')
    expect(personalUpdateMany.mock.calls[0][0].data.status).toBeUndefined()
  })

  it('transport error propagates (callback must answer non-2xx so Epay retries)', async () => {
    queryPayin.mockRejectedValue(new EpayUnavailableError('/q', 'timeout'))
    await expect(epayPayinService.settlePayin(CP, 'callback')).rejects.toBeInstanceOf(
      EpayUnavailableError,
    )
  })

  it('already-final orders are not queried again', async () => {
    personalFindUnique.mockResolvedValue(personalOrder({ status: 'PAID' }))
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('ALREADY_FINAL')
    expect(queryPayin).not.toHaveBeenCalled()
  })

  it('unknown / foreign order numbers are ignored without a query', async () => {
    personalFindUnique.mockResolvedValue(null)
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('UNKNOWN_ORDER')
    expect(await epayPayinService.settlePayin('WD261120ABCDEF0123456789', 'callback')).toBe(
      'UNKNOWN_ORDER',
    )
    expect(queryPayin).not.toHaveBeenCalled()
  })

  it('trading orders credit through coinTradingService with the Decimal USD amount', async () => {
    tradingFindUnique.mockResolvedValue({
      id: 'ct-1',
      status: 'PENDING',
      createdAt: minutesAgo(3),
      amountUsd: new Prisma.Decimal('100.00'),
      currency: 'USD',
    })
    queryPayin.mockResolvedValue({ status: '7', amount: '100', currency: 'USD' })
    expect(await epayPayinService.settlePayin(CT, 'callback')).toBe('CREDITED')
    expect(creditTrading).toHaveBeenCalledWith('ct-1', expect.objectContaining({ epayStatus: '7' }))
    expect(creditPersonal).not.toHaveBeenCalled()
  })

  it('a lost credit race reports ALREADY_FINAL', async () => {
    queryPayin.mockResolvedValue({ status: '7', amount: '2.99', currency: 'USD' })
    creditPersonal.mockResolvedValue(null)
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('ALREADY_FINAL')
  })
})

describe('late payment (order closed before Epay confirmed it)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    personalUpdateMany.mockResolvedValue({ count: 1 })
    creditPersonal.mockResolvedValue({ ledgerEntryId: 'l1' })
  })

  it.each(['FAILED', 'EXPIRED'])(
    'callback on a %s order + Epay status 7 + exact match → credited',
    async (status) => {
      personalFindUnique.mockResolvedValue(personalOrder({ status, createdAt: minutesAgo(26 * 60) }))
      queryPayin.mockResolvedValue({ status: '7', amount: '2.99', currency: 'USD', epayOrderNo: 'EP-L' })
      expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('CREDITED')
      expect(creditPersonal).toHaveBeenCalledWith('ord-1', expect.objectContaining({ epayOrderNo: 'EP-L' }))
    },
  )

  it('late callback but Epay does not say 7 → nothing changes', async () => {
    personalFindUnique.mockResolvedValue(personalOrder({ status: 'EXPIRED' }))
    queryPayin.mockResolvedValue({ status: '8' })
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('ALREADY_FINAL')
    expect(personalUpdateMany).not.toHaveBeenCalled()
    expect(creditPersonal).not.toHaveBeenCalled()
  })

  it('late callback, status 7 but amount mismatch → REVIEW (from the closed status), not credited', async () => {
    personalFindUnique.mockResolvedValue(personalOrder({ status: 'FAILED' }))
    queryPayin.mockResolvedValue({ status: '7', amount: '1.00', currency: 'USD' })
    expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('REVIEW')
    const call = personalUpdateMany.mock.calls[0][0]
    expect(call.where).toEqual({ id: 'ord-1', status: { in: ['FAILED'] } })
    expect(call.data.status).toBe('REVIEW')
    expect(call.data.failureReason).toMatch(/^LATE_AMOUNT_MISMATCH/)
    expect(creditPersonal).not.toHaveBeenCalled()
  })

  it('reconcile and poll never re-open closed orders (no Epay query)', async () => {
    personalFindUnique.mockResolvedValue(personalOrder({ status: 'EXPIRED' }))
    expect(await epayPayinService.settlePayin(CP, 'reconcile')).toBe('ALREADY_FINAL')
    expect(await epayPayinService.settlePayin(CP, 'poll')).toBe('ALREADY_FINAL')
    expect(queryPayin).not.toHaveBeenCalled()
  })

  it('PAID and REVIEW are never re-opened, even by a callback', async () => {
    for (const status of ['PAID', 'REVIEW']) {
      personalFindUnique.mockResolvedValue(personalOrder({ status }))
      expect(await epayPayinService.settlePayin(CP, 'callback')).toBe('ALREADY_FINAL')
    }
    expect(queryPayin).not.toHaveBeenCalled()
  })

  it('a dropped Epay connection during a late re-check propagates (callback is retried)', async () => {
    personalFindUnique.mockResolvedValue(personalOrder({ status: 'EXPIRED' }))
    queryPayin.mockRejectedValue(new EpayUnavailableError('/q', 'timeout'))
    await expect(epayPayinService.settlePayin(CP, 'callback')).rejects.toBeInstanceOf(
      EpayUnavailableError,
    )
  })
})

describe('poll refresh + single-flight gate (latency / stampede)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    personalFindUnique.mockResolvedValue(personalOrder())
    personalUpdateMany.mockResolvedValue({ count: 1 })
    creditPersonal.mockResolvedValue({ ledgerEntryId: 'l1' })
  })

  it('gate is SET NX PX on a per-order key; a held gate says no', async () => {
    redisSet.mockResolvedValueOnce('OK').mockResolvedValueOnce(null)
    expect(await acquireEpayQueryGate(CP, 5000)).toBe(true)
    expect(await acquireEpayQueryGate(CP, 5000)).toBe(false)
    expect(redisSet).toHaveBeenCalledWith(`epay:qgate:${CP}`, '1', 'PX', 5000, 'NX')
  })

  it('gate fails OPEN when Redis is down (crediting is DB-enforced anyway)', async () => {
    redisSet.mockRejectedValue(new Error('redis down'))
    expect(await acquireEpayQueryGate(CP, 5000)).toBe(true)
  })

  it('kickRefresh returns synchronously even if Epay hangs; the settle runs in the background', async () => {
    redisSet.mockResolvedValue('OK')
    let release!: (v: unknown) => void
    queryPayin.mockReturnValue(new Promise((r) => (release = r)))
    const t0 = Date.now()
    const ret = epayPayinService.kickRefresh(CP)
    expect(ret).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(5)
    await vi.waitFor(() => expect(queryPayin).toHaveBeenCalledTimes(1))
    release({ status: '7', amount: '2.99', currency: 'USD' })
    await vi.waitFor(() => expect(creditPersonal).toHaveBeenCalledTimes(1))
  })

  it('100 concurrent polls on one order → one Epay query', async () => {
    let first = true
    redisSet.mockImplementation(async () => {
      if (first) {
        first = false
        return 'OK'
      }
      return null
    })
    queryPayin.mockResolvedValue({ status: '0' })
    for (let i = 0; i < 100; i++) epayPayinService.kickRefresh(CP)
    await vi.waitFor(() => expect(redisSet).toHaveBeenCalledTimes(100))
    await new Promise((r) => setTimeout(r, 10))
    expect(queryPayin).toHaveBeenCalledTimes(1)
  })

  it('kickRefresh is a no-op for non-pending orders (null order no)', () => {
    epayPayinService.kickRefresh(null)
    expect(redisSet).not.toHaveBeenCalled()
  })

  it('a failing background settle never throws into the request', async () => {
    redisSet.mockResolvedValue('OK')
    queryPayin.mockRejectedValue(new Error('boom'))
    expect(() => epayPayinService.kickRefresh(CP)).not.toThrow()
    await vi.waitFor(() => expect(queryPayin).toHaveBeenCalled())
  })
})

describe('checkPaidMatchesOrder', () => {
  it('accepts an absent merchantOrderNo in the query response', () => {
    const r = checkPaidMatchesOrder(
      { expectedAmount: new Prisma.Decimal('9.99'), expectedCurrency: 'USD' },
      CP,
      { status: '7', amount: '9.99', currency: 'USD' },
    )
    expect(r.ok).toBe(true)
  })
})
