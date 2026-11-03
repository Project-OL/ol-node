import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/config/env', () => ({
  env: {
    RESEND_API_KEY: 're_test_key',
    EMAIL_FROM: 'noreply@example.com',
  },
}))

const { resendProvider } = await import('../../src/services/providers/resend.provider')
const { resendCircuitBreaker } = await import('../../src/utils/circuitBreaker')

const fetchMock = vi.fn()

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    json: async () => body,
  }
}

describe('resend.provider', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends the OTP email with the bearer key and returns the Resend id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'resend-1' }))

    const result = await resendProvider.sendOtpEmail({
      email: 'user@example.com',
      otp: '4321',
      purpose: 'login',
    })

    expect(result).toEqual({ success: true, providerMessageId: 'resend-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe('Bearer re_test_key')
    const body = JSON.parse(init.body)
    expect(body.from).toBe('noreply@example.com')
    expect(body.to).toEqual(['user@example.com'])
    expect(body.text).toContain('4321')
  })

  it('does not trip the breaker on a 4xx request error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { message: 'Invalid `to` field' }))

    for (let i = 0; i < 6; i++) {
      const result = await resendProvider.sendTransactionalEmail({
        email: 'bad',
        subject: 's',
        text: 't',
        html: 'h',
      })
      expect(result).toEqual({ success: false, error: 'Resend 422: Invalid `to` field' })
    }
    expect(resendCircuitBreaker.getState()).toBe('closed')
  })

  it('retries a 429 with backoff and succeeds without touching the breaker (BE-29)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(429, { name: 'rate_limit_exceeded' }))
      .mockResolvedValueOnce(jsonResponse(429, { name: 'rate_limit_exceeded' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'resend-429' }))

    const pending = resendProvider.sendOtpEmail({ email: 'user@example.com', otp: '1', purpose: 'login' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toEqual({ success: true, providerMessageId: 'resend-429' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[0][1].body)
  })

  it('a burst of 429s never opens the breaker; gives up after 2 retries', async () => {
    fetchMock.mockResolvedValue({
      ...jsonResponse(429, { message: 'Too many requests' }),
      headers: new Headers({ 'retry-after': '1' }),
    })

    for (let i = 0; i < 6; i++) {
      const pending = resendProvider.sendOtpEmail({ email: 'user@example.com', otp: '1', purpose: 'login' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await pending).toEqual({ success: false, error: 'Resend 429: Too many requests' })
    }
    expect(fetchMock).toHaveBeenCalledTimes(18)
    expect(resendCircuitBreaker.getState()).toBe('closed')
  })

  it('still counts 5xx toward the breaker and does not retry it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { message: 'unavailable' }))
    const result = await resendProvider.sendOtpEmail({ email: 'user@example.com', otp: '1', purpose: 'login' })
    expect(result).toEqual({ success: false, error: 'Resend 503: unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resendCircuitBreaker.recordSuccess()
  })

  it('opens after threshold network failures, short-circuits, then recovers', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))

    for (let i = 0; i < 5; i++) {
      const result = await resendProvider.sendOtpEmail({
        email: 'user@example.com',
        otp: '1234',
        purpose: 'login',
      })
      expect(result.success).toBe(false)
    }
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(resendCircuitBreaker.getState()).toBe('open')

    const skipped = await resendProvider.sendOtpEmail({
      email: 'user@example.com',
      otp: '1234',
      purpose: 'login',
    })
    expect(skipped).toEqual({ success: false, error: 'Resend temporarily unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(5)

    vi.setSystemTime(15_000)
    resendCircuitBreaker.getState()
    vi.setSystemTime(18_000)

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { id: 'resend-2' }))
    const recovered = await resendProvider.sendOtpEmail({
      email: 'user@example.com',
      otp: '1234',
      purpose: 'login',
    })
    expect(recovered).toEqual({ success: true, providerMessageId: 'resend-2' })
    expect(resendCircuitBreaker.getState()).toBe('closed')
  })
})
