import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'

const findById = vi.fn()
vi.mock('../../src/repositories/user.repository', () => ({
  userRepository: { findById: (...a: unknown[]) => findById(...a) },
}))
vi.mock('../../src/services/agency.service', () => ({
  agencyService: { enforcePauseGate: vi.fn().mockResolvedValue(undefined) },
}))
const getTopupPackageById = vi.fn()
vi.mock('../../src/repositories/coinTrading.repository', () => ({
  coinTradingRepository: { getTopupPackageById: (...a: unknown[]) => getTopupPackageById(...a) },
}))
const getCachedIdemResponse = vi.fn()
const acquireIdemKey = vi.fn()
const resolveIdemKey = vi.fn()
vi.mock('../../src/services/wallet.service', () => ({
  walletService: {
    getCachedIdemResponse: (...a: unknown[]) => getCachedIdemResponse(...a),
    acquireIdemKey: (...a: unknown[]) => acquireIdemKey(...a),
    resolveIdemKey: (...a: unknown[]) => resolveIdemKey(...a),
  },
}))
const orderCreate = vi.fn()
const orderUpdate = vi.fn()
vi.mock('../../src/config/database', () => ({
  prisma: {
    coinTradingTopupOrder: {
      create: (...a: unknown[]) => orderCreate(...a),
      update: (...a: unknown[]) => orderUpdate(...a),
    },
  },
  prismaRead: {},
}))
const createOrder = vi.fn()
const epayEnabled = vi.fn(() => true)
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const { AppError } = await import('../../src/middlewares/errorHandler')
  class EpayRejectedError extends AppError {
    constructor() {
      super(502, 'rejected', 'EPAY_REJECTED')
      Object.setPrototypeOf(this, new.target.prototype)
    }
  }
  return {
    epayGateway: { createCashierPayin: (...a: unknown[]) => createOrder(...a) },
    isEpayConfigured: () => epayEnabled(),
    EpayRejectedError,
  }
})
const redisDel = vi.fn()
vi.mock('../../src/config/redis', () => ({
  redisClient: { del: (...a: unknown[]) => redisDel(...a), get: vi.fn(), set: vi.fn() },
  RedisKeys: { walletIdem: (k: string) => `wallet:idem:${k}` },
  CT_BALANCE_TTL: 300,
  CT_RATES_TTL: 3600,
  CT_RECENT_USERS_TTL: 120,
}))

const { coinTradingService } = await import('../../src/services/coinTrading.service')

const input = {
  packageId: 'pkg-1',
  currency: 'USD',
  callbackUrl: 'https://cb.example',
  returnUrl: 'https://ret.example',
  idempotencyKey: 'client-key-123',
}

describe('coinTradingService.initiateTopup idempotency', () => {
  beforeEach(() => {
    findById.mockReset().mockResolvedValue({ id: 'agent-1', isAgent: true })
    getTopupPackageById.mockReset().mockResolvedValue({
      id: 'pkg-1',
      priceCents: 10_000,
      tradingCoins: 940_000n,
      coinsPerUsd: 9400,
    })
    getCachedIdemResponse.mockReset().mockResolvedValue(null)
    acquireIdemKey.mockReset().mockResolvedValue(true)
    resolveIdemKey.mockReset().mockResolvedValue(undefined)
    orderCreate.mockReset().mockResolvedValue({ id: 'order-1' })
    orderUpdate.mockReset().mockResolvedValue({})
    createOrder
      .mockReset()
      .mockResolvedValue({ epayUrl: 'https://pay', epayOrderNo: 'gw-1', status: '0' })
    redisDel.mockReset().mockResolvedValue(1)
    epayEnabled.mockReset().mockReturnValue(true)
  })

  it('refuses before any write while Epay is disabled', async () => {
    epayEnabled.mockReturnValue(false)
    await expect(coinTradingService.initiateTopup('agent-1', input)).rejects.toMatchObject({
      statusCode: 503,
      code: 'EPAY_DISABLED',
    })
    expect(acquireIdemKey).not.toHaveBeenCalled()
    expect(orderCreate).not.toHaveBeenCalled()
  })

  it('rejects non-USD before any write', async () => {
    await expect(
      coinTradingService.initiateTopup('agent-1', { ...input, currency: 'EUR' }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'CURRENCY_NOT_SUPPORTED' })
    expect(orderCreate).not.toHaveBeenCalled()
  })

  it('sends the cashier order with a CT merchantOrderNo and the exact amount; ignores client URLs', async () => {
    const out = await coinTradingService.initiateTopup('agent-1', input)
    const created = orderCreate.mock.calls[0]![0] as { data: { merchantOrderNo: string } }
    expect(created.data.merchantOrderNo).toMatch(/^CT\d{6}[0-9A-F]{16}$/)
    expect(createOrder).toHaveBeenCalledWith({
      merchantOrderNo: created.data.merchantOrderNo,
      amount: '100.00',
      currency: 'USD',
      remark: 'Trading coin top-up',
    })
    expect(JSON.stringify(createOrder.mock.calls[0])).not.toContain('cb.example')
    expect(orderUpdate).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { epayRef: 'gw-1', paymentUrl: 'https://pay', epayStatus: '0' },
    })
    expect(out).toMatchObject({ paymentUrl: 'https://pay', merchantOrderNo: created.data.merchantOrderNo })
  })

  it('replays the cached response without creating another order', async () => {
    const snapshot = {
      paymentUrl: 'https://pay',
      orderId: 'order-1',
      amountUsd: '100.00',
      tradingCoinsAwarded: '940000',
      packageId: 'pkg-1',
    }
    getCachedIdemResponse.mockResolvedValue(snapshot)
    const out = await coinTradingService.initiateTopup('agent-1', input)
    expect(out).toEqual(snapshot)
    expect(orderCreate).not.toHaveBeenCalled()
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('rejects an in-flight duplicate with 409 IDEM_CONFLICT', async () => {
    acquireIdemKey.mockResolvedValue(false)
    await expect(coinTradingService.initiateTopup('agent-1', input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEM_CONFLICT',
    })
    expect(orderCreate).not.toHaveBeenCalled()
  })

  it('derives the order key from the client key and snapshots the response', async () => {
    const out = await coinTradingService.initiateTopup('agent-1', input)
    expect(orderCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: 'trading-topup:agent-1:client-key-123',
        }),
      }),
    )
    expect(resolveIdemKey).toHaveBeenCalledWith('ct-topup:agent-1:client-key-123', out)
    expect(out.orderId).toBe('order-1')
  })

  it('maps a post-window duplicate (order unique violation) to 409 IDEM_CONFLICT', async () => {
    orderCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )
    await expect(coinTradingService.initiateTopup('agent-1', input)).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEM_CONFLICT',
    })
    expect(createOrder).not.toHaveBeenCalled()
  })

  it('without a client key: no replay envelope, order key is time-based (legacy)', async () => {
    const legacyInput = { ...input, idempotencyKey: undefined }
    await coinTradingService.initiateTopup('agent-1', legacyInput)
    expect(getCachedIdemResponse).not.toHaveBeenCalled()
    expect(acquireIdemKey).not.toHaveBeenCalled()
    const created = orderCreate.mock.calls[0]![0] as { data: { idempotencyKey: string } }
    expect(created.data.idempotencyKey).toMatch(/^trading-topup:agent-1:\d+$/)
  })
})
