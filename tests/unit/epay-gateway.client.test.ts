import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()
vi.mock('axios', () => ({ default: { create: () => ({ post }) } }))

const env: Record<string, unknown> = {}
vi.mock('../../src/config/env', () => ({ env }))
vi.mock('../../src/utils/rootLogger', () => ({
  rootLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const breaker = { shouldSkip: vi.fn(() => false), recordSuccess: vi.fn(), recordFailure: vi.fn() }
vi.mock('../../src/utils/circuitBreaker', () => ({ epayCircuitBreaker: breaker }))

const {
  epayGateway,
  classifyEpayStatus,
  parseEpayCallbackBody,
  verifyEpayCallback,
  EpayRejectedError,
  EpayUnavailableError,
  __resetEpayHttpForTests,
} = await import('../../src/lib/epay/epay-gateway.client')
const { epaySign } = await import('../../src/lib/epay/epay-sign')

const ENABLED_ENV = {
  EPAY_ENABLED: true,
  EPAY_API_BASE_URL: 'https://epay.example.test/capi/openapi',
  EPAY_ACCOUNT: 'merchant@example.test',
  EPAY_MERCHANT_NAME: 'Test Merchant',
  EPAY_PAYIN_KEY: 'PAYINKEY',
  EPAY_PAYOUT_KEY: 'PAYOUTKEY',
  EPAY_NOTIFY_URL: 'https://api.example.test/api/v1/webhooks/epay',
  EPAY_SUCCESS_URL: 'https://example.test/ok',
  EPAY_FAIL_URL: undefined,
  EPAY_PAYIN_CHANNEL_CODE: undefined,
  EPAY_PAYIN_CHECKOUT_TYPE: undefined,
  EPAY_API_VERSION: 'V2.0.0',
  EPAY_HTTP_TIMEOUT_MS: 1000,
}

const ok = (data: unknown) => ({ data: { code: 1, message: 'success', data } })

describe('epay gateway client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    breaker.shouldSkip.mockReturnValue(false)
    for (const k of Object.keys(env)) delete env[k]
    Object.assign(env, ENABLED_ENV)
    __resetEpayHttpForTests()
  })

  it('refuses every call with EPAY_DISABLED when not enabled', async () => {
    env.EPAY_ENABLED = false
    await expect(epayGateway.queryPayin('CP1')).rejects.toMatchObject({ code: 'EPAY_DISABLED' })
    expect(post).not.toHaveBeenCalled()
  })

  it('cashier pay-in: posts {param, sign} signed with the PAYIN key, drops empty fields', async () => {
    post.mockResolvedValueOnce(ok({ epayUrl: 'https://pay.example/x', status: '0' }))
    const res = await epayGateway.createCashierPayin({
      merchantOrderNo: 'CPabc',
      amount: '4.99',
      currency: 'USD',
    })
    expect(res.epayUrl).toBe('https://pay.example/x')
    const [path, body] = post.mock.calls[0]
    expect(path).toBe('/gateway/sendTransaction')
    expect(body.param).toMatchObject({
      epayAccount: 'merchant@example.test',
      version: 'V2.0.0',
      merchantName: 'Test Merchant',
      merchantOrderNo: 'CPabc',
      amount: '4.99',
      currency: 'USD',
      notifyUrl: 'https://api.example.test/api/v1/webhooks/epay',
    })
    expect(body.sign).toBe(epaySign(body.param, 'PAYINKEY'))
    expect(body.sign).not.toBe(epaySign(body.param, 'PAYOUTKEY'))
  })

  it('cashier pay-in without epayUrl is treated as a rejection', async () => {
    post.mockResolvedValueOnce(ok({ status: '0' }))
    await expect(
      epayGateway.createCashierPayin({ merchantOrderNo: 'CP1', amount: '1.00', currency: 'USD' }),
    ).rejects.toBeInstanceOf(EpayRejectedError)
  })

  it('money-moving calls are sent once, even on 5xx / timeout', async () => {
    post.mockRejectedValue({ response: { status: 503 }, message: 'Service Unavailable' })
    await expect(
      epayGateway.createEpayTransfer({
        merchantOrderNo: 'WD1',
        amount: '10.00',
        currency: 'USD',
        receiveEpayAccount: 'host@example.test',
      }),
    ).rejects.toBeInstanceOf(EpayUnavailableError)
    expect(post).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).toHaveBeenCalledTimes(1)
    const [path, body] = post.mock.calls[0]
    expect(path).toBe('/payoutApi/createEpayTransaction')
    expect(body.sign).toBe(epaySign(body.param, 'PAYOUTKEY'))
  })

  it('queries retry transient failures, then succeed', async () => {
    vi.useFakeTimers()
    post
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(ok({ merchantOrderNo: 'CP1', status: '7' }))
    const p = epayGateway.queryPayin('CP1')
    await vi.runAllTimersAsync()
    await expect(p).resolves.toMatchObject({ status: '7' })
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[0][0]).toBe('/payinApi/queryTransaction')
    vi.useRealTimers()
  })

  it('a business rejection (code != 1) is not retried and does not trip the breaker', async () => {
    post.mockResolvedValueOnce({ data: { code: 0, message: 'order not exist' } })
    const err = await epayGateway.queryPayout('WD1').catch((e) => e)
    expect(err).toBeInstanceOf(EpayRejectedError)
    expect(err.details).toMatchObject({ epayCode: 0, epayMessage: 'order not exist' })
    expect(post).toHaveBeenCalledTimes(1)
    expect(breaker.recordFailure).not.toHaveBeenCalled()
  })

  it('fails fast while the circuit is open', async () => {
    breaker.shouldSkip.mockReturnValue(true)
    await expect(epayGateway.queryPayin('CP1')).rejects.toMatchObject({ code: 'EPAY_CIRCUIT_OPEN' })
    expect(post).not.toHaveBeenCalled()
  })
})

describe('classifyEpayStatus', () => {
  it('only 7 is success; 5/6/8/20 are final failures; the rest wait', () => {
    expect(classifyEpayStatus('7')).toBe('SUCCESS')
    expect(classifyEpayStatus(7)).toBe('SUCCESS')
    for (const s of ['5', '6', '8', '20']) expect(classifyEpayStatus(s)).toBe('FAILED')
    for (const s of ['0', '1', '9', '11', '19', '', null, undefined, '99']) {
      expect(classifyEpayStatus(s)).toBe('PENDING')
    }
  })
})

describe('Epay callbacks', () => {
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k]
    Object.assign(env, ENABLED_ENV)
  })

  const fields = {
    epayAccount: 'merchant@example.test',
    merchantOrderNo: 'CPabc',
    epayOrderNo: '2111515985',
    amount: '4.99',
    status: '7',
    remark: '',
    version: 'V2.0.0',
  }

  it('parses a form-urlencoded body into flat strings', () => {
    const raw = new URLSearchParams({ ...fields, sign: 'S' }).toString()
    expect(parseEpayCallbackBody(Buffer.from(raw))).toEqual({ ...fields, sign: 'S' })
  })

  it('verifies with the key for the order direction only', () => {
    const signed = { ...fields, sign: epaySign(fields, 'PAYINKEY') }
    expect(verifyEpayCallback(signed, 'PAYIN')).toBe(true)
    expect(verifyEpayCallback(signed, 'PAYOUT')).toBe(false)
    expect(verifyEpayCallback({ ...signed, amount: '499.00' }, 'PAYIN')).toBe(false)
  })

  it('never verifies while Epay is disabled', () => {
    env.EPAY_ENABLED = false
    const signed = { ...fields, sign: epaySign(fields, 'PAYINKEY') }
    expect(verifyEpayCallback(signed, 'PAYIN')).toBe(false)
  })
})
