import { env } from '../../config/env'
import type { EmailOtpParams, OtpProviderResult, TransactionalEmailParams } from './provider.types'
import { resendCircuitBreaker } from '../../utils/circuitBreaker'
import { buildOtpEmailBody, OTP_EMAIL_SUBJECT } from './otp-email-body'

const RESEND_API_URL = 'https://api.resend.com/emails'
const RESEND_TIMEOUT_MS = 10_000
/** BE-29: a 429 is Resend's per-second rate limit, not an outage: retry it, never count it. */
const RESEND_429_MAX_RETRIES = 2
const RESEND_429_MAX_WAIT_MS = 2_000

interface ResendSendResponse {
  id?: string
  message?: string
  name?: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Honour `Retry-After` (seconds) when sent, else 300 ms, 600 ms; capped, with a little jitter. */
function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers?.get?.('retry-after'))
  const base =
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 300 * 2 ** attempt
  return Math.min(RESEND_429_MAX_WAIT_MS, base) + Math.floor(Math.random() * 100)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function send(params: TransactionalEmailParams): Promise<OtpProviderResult> {
  const from = env.EMAIL_FROM ?? env.SES_FROM_EMAIL
  if (!env.RESEND_API_KEY) {
    return { success: false, error: 'RESEND_API_KEY is not configured' }
  }
  if (!from) {
    return { success: false, error: 'EMAIL_FROM / SES_FROM_EMAIL is not configured' }
  }
  if (resendCircuitBreaker.shouldSkip()) {
    return { success: false, error: 'Resend temporarily unavailable' }
  }
  const body = JSON.stringify({
    from,
    to: [params.email],
    subject: params.subject,
    text: params.text,
    html: params.html,
  })
  try {
    let response: Response
    let data: ResendSendResponse
    for (let attempt = 0; ; attempt++) {
      response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      })
      data = (await response.json().catch(() => ({}))) as ResendSendResponse
      if (response.status !== 429 || attempt >= RESEND_429_MAX_RETRIES) break
      await sleep(retryDelayMs(response, attempt))
    }

    if (!response.ok) {
      // 5xx means Resend itself is struggling. 429 (rate limit, already retried above) and
      // other 4xx (bad recipient, unverified domain) must not trip the breaker: a burst of
      // OTP sign-ups would otherwise open it and fail every email OTP for 15 s (BE-29).
      if (response.status >= 500) {
        resendCircuitBreaker.recordFailure()
      }
      return {
        success: false,
        error: `Resend ${response.status}: ${data.message ?? data.name ?? response.statusText}`,
      }
    }

    resendCircuitBreaker.recordSuccess()
    return { success: true, providerMessageId: data.id }
  } catch (error) {
    resendCircuitBreaker.recordFailure()
    return { success: false, error: errorMessage(error) }
  }
}

export const resendProvider = {
  async sendOtpEmail(params: EmailOtpParams): Promise<OtpProviderResult> {
    const body = buildOtpEmailBody(params.otp)
    return send({
      email: params.email,
      subject: OTP_EMAIL_SUBJECT,
      text: body.text,
      html: body.html,
    })
  },

  async sendTransactionalEmail(params: TransactionalEmailParams): Promise<OtpProviderResult> {
    return send(params)
  },
}
