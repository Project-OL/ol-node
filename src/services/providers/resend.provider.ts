import { env } from '../../config/env'
import type { EmailOtpParams, OtpProviderResult, TransactionalEmailParams } from './provider.types'
import { resendCircuitBreaker } from '../../utils/circuitBreaker'
import { buildOtpEmailBody, OTP_EMAIL_SUBJECT } from './otp-email-body'

const RESEND_API_URL = 'https://api.resend.com/emails'
const RESEND_TIMEOUT_MS = 10_000

interface ResendSendResponse {
  id?: string
  message?: string
  name?: string
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

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
  try {
    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.email],
        subject: params.subject,
        text: params.text,
        html: params.html,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    })
    const data = (await response.json().catch(() => ({}))) as ResendSendResponse

    if (!response.ok) {
      // 5xx / 429 mean Resend itself is struggling; other 4xx (bad recipient,
      // unverified domain) are request problems and must not trip the breaker.
      if (response.status >= 500 || response.status === 429) {
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
