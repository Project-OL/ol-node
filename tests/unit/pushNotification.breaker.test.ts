import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const send = vi.fn()
const sendEachForMulticast = vi.fn()

vi.mock('../../src/config/firebase', () => ({
  assertFirebaseCredentials: vi.fn().mockResolvedValue(undefined),
  getFirebaseMessaging: () => ({ send, sendEachForMulticast }),
}))
vi.mock('../../src/config/database', () => ({
  prisma: { user: { update: vi.fn().mockResolvedValue({}) } },
  prismaRead: {},
}))
vi.mock('../../src/services/pushDeliveryLog.service', () => ({
  pushDeliveryLogService: { record: vi.fn(), recordMany: vi.fn() },
}))

const { pushNotificationService } = await import('../../src/services/pushNotification.service')
const { fcmCircuitBreaker } = await import('../../src/utils/circuitBreaker')

const payload = { title: 't', body: 'b' }
const fcmError = (code: string) => Object.assign(new Error(code), { errorInfo: { code, message: code } })

describe('push FCM circuit breaker (BE-09 P4)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => vi.useRealTimers())

  it('bad-token errors never open it', async () => {
    send.mockRejectedValue(fcmError('messaging/registration-token-not-registered'))
    for (let i = 0; i < 12; i++) await pushNotificationService.sendToToken('u', 'tok', payload)
    expect(fcmCircuitBreaker.getState()).toBe('closed')
    expect(send).toHaveBeenCalledTimes(12)
  })

  it('opens after 8 infra failures, then skips without calling FCM, then recovers', async () => {
    send.mockRejectedValue(fcmError('messaging/server-unavailable'))
    for (let i = 0; i < 8; i++) {
      const r = await pushNotificationService.sendToToken('u', 'tok', payload)
      expect(r).toMatchObject({ success: false, error: 'messaging/server-unavailable' })
    }
    expect(fcmCircuitBreaker.getState()).toBe('open')

    const skipped = await pushNotificationService.sendToToken('u', 'tok', payload)
    expect(skipped).toMatchObject({ success: false, skipped: true, error: 'FCM_CIRCUIT_OPEN' })
    const multi = await pushNotificationService.sendMulticast(['a', 'b'], payload)
    expect(multi).toEqual({ successCount: 0, failureCount: 2 })
    expect(send).toHaveBeenCalledTimes(8)
    expect(sendEachForMulticast).not.toHaveBeenCalled()

    vi.setSystemTime(20_000)
    fcmCircuitBreaker.getState()
    vi.setSystemTime(23_000)
    send.mockResolvedValueOnce('msg-id')
    expect(await pushNotificationService.sendToToken('u', 'tok', payload)).toEqual({ success: true })
    expect(fcmCircuitBreaker.getState()).toBe('closed')
  })
})
