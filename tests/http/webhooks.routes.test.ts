import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHttpTestApp } from './helpers/http-test-app'

import { epaySign, verifyEpaySign } from '../../src/lib/epay/epay-sign'

const handleSessionStart = vi.fn()
const handleSessionEnd = vi.fn()
const settlePayin = vi.fn()
const settlePayout = vi.fn()
const epayEnabled = vi.fn(() => true)

// Real form parsing + real signature check, with fixed test keys per direction.
vi.mock('../../src/lib/epay/epay-gateway.client', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/epay/epay-gateway.client')
  >('../../src/lib/epay/epay-gateway.client')
  return {
    isEpayConfigured: () => epayEnabled(),
    parseEpayCallbackBody: actual.parseEpayCallbackBody,
    verifyEpayCallback: (fields: Record<string, string>, kind: 'PAYIN' | 'PAYOUT') =>
      verifyEpaySign(fields, kind === 'PAYIN' ? 'PAYIN_TEST_KEY' : 'PAYOUT_TEST_KEY'),
  }
})

vi.mock('../../src/services/epay-payin.service', () => ({
  epayPayinService: { settlePayin: (...a: unknown[]) => settlePayin(...a) },
}))

vi.mock('../../src/services/epay-payout.service', () => ({
  epayPayoutService: { settlePayout: (...a: unknown[]) => settlePayout(...a) },
}))

vi.mock('../../src/services/liveSession.service', () => ({
  liveSessionService: {
    handleSessionStart: (...a: unknown[]) => handleSessionStart(...a),
    handleSessionEnd: (...a: unknown[]) => handleSessionEnd(...a),
  },
}))

import { webhooksRoutes } from '../../src/routes/v1/webhooks.routes'

describe('HTTP contract: webhook routes', () => {
  let app: Awaited<ReturnType<typeof createHttpTestApp>>

  beforeEach(async () => {
    settlePayin.mockReset()
    settlePayout.mockReset()
    epayEnabled.mockReset().mockReturnValue(true)
    handleSessionStart.mockReset()
    handleSessionEnd.mockReset()
    app = await createHttpTestApp(webhooksRoutes, { prefix: '/api/v1/webhooks' })
  })

  afterEach(async () => {
    await app.close()
  })

  const PAYIN_NO = 'CP261120ABCDEF0123456789'
  const PAYOUT_NO = 'WD261120ABCDEF0123456789'
  const formCallback = (fields: Record<string, string>, key: string) => {
    const signed = { ...fields, sign: epaySign(fields, key) }
    return {
      method: 'POST' as const,
      url: '/api/v1/webhooks/epay',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(signed).toString(),
    }
  }

  it('POST /webhooks/epay: signed form callback → settles from Epay query, replies plain "success"', async () => {
    settlePayin.mockResolvedValue('CREDITED')
    const res = await app.inject(
      formCallback(
        { merchantOrderNo: PAYIN_NO, status: '7', amount: '2.99', currency: 'USD' },
        'PAYIN_TEST_KEY',
      ),
    )
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/^text\/plain/)
    expect(res.body).toBe('success')
    expect(settlePayin).toHaveBeenCalledWith(PAYIN_NO, 'callback')
  })

  it('POST /webhooks/epay: wrong key / tampered field → 401, nothing settled', async () => {
    const res = await app.inject(
      formCallback({ merchantOrderNo: PAYIN_NO, status: '7' }, 'PAYOUT_TEST_KEY'),
    )
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'INVALID_WEBHOOK_SIGNATURE' })

    const ok = formCallback({ merchantOrderNo: PAYIN_NO, status: '6' }, 'PAYIN_TEST_KEY')
    const tampered = await app.inject({ ...ok, payload: ok.payload.replace('status=6', 'status=7') })
    expect(tampered.statusCode).toBe(401)
    expect(settlePayin).not.toHaveBeenCalled()
  })

  it('POST /webhooks/epay: unknown merchantOrderNo → 400', async () => {
    const res = await app.inject(
      formCallback({ merchantOrderNo: 'not-ours', status: '7' }, 'PAYIN_TEST_KEY'),
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'EPAY_UNKNOWN_ORDER' })
  })

  it('POST /webhooks/epay: payout callbacks verify with the PAYOUT key and settle the payout', async () => {
    settlePayout.mockResolvedValue('SUCCESS')
    const res = await app.inject(
      formCallback({ merchantOrderNo: PAYOUT_NO, status: '7' }, 'PAYOUT_TEST_KEY'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('success')
    expect(settlePayout).toHaveBeenCalledWith(PAYOUT_NO, 'callback')
    expect(settlePayin).not.toHaveBeenCalled()
  })

  it('POST /webhooks/epay: settle error → 5xx so Epay retries', async () => {
    settlePayin.mockRejectedValue(new Error('db down'))
    const res = await app.inject(
      formCallback({ merchantOrderNo: PAYIN_NO, status: '7' }, 'PAYIN_TEST_KEY'),
    )
    expect(res.statusCode).toBeGreaterThanOrEqual(500)
    expect(res.body).not.toBe('success')
  })

  it('POST /webhooks/epay: 503 while Epay is disabled', async () => {
    epayEnabled.mockReturnValue(false)
    const res = await app.inject(
      formCallback({ merchantOrderNo: PAYIN_NO, status: '7' }, 'PAYIN_TEST_KEY'),
    )
    expect(res.statusCode).toBe(503)
    expect(settlePayin).not.toHaveBeenCalled()
  })

  it('POST /webhooks/live/session-start returns 401 without secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/live/session-start',
      payload: {
        hostUserId: 'h1',
        agencyUserId: 'a1',
        roomId: 'room-1',
      },
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /webhooks/live/session-start returns 200 with valid secret', async () => {
    handleSessionStart.mockResolvedValue({ alreadyActive: false })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/live/session-start',
      headers: { 'x-live-webhook-secret': process.env.LIVE_WEBHOOK_SECRET! },
      payload: {
        hostUserId: 'h1',
        agencyUserId: 'a1',
        roomId: 'room-1',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(handleSessionStart).toHaveBeenCalled()
  })
})
