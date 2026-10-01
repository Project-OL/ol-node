import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses'
import { env } from '../../config/env'
import type { EmailOtpParams, OtpProviderResult, TransactionalEmailParams } from './provider.types'
import { sesCircuitBreaker } from '../../utils/circuitBreaker'
import { buildOtpEmailBody, OTP_EMAIL_SUBJECT } from './otp-email-body'

const sesClient = new SESClient({
  region: env.AWS_REGION,
  credentials:
    env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.SES_ACCESS_KEY_ID,
          secretAccessKey: env.SES_SECRET_ACCESS_KEY,
        }
      : undefined,
})

function fromEmail(): string | undefined {
  return env.EMAIL_FROM ?? env.SES_FROM_EMAIL
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export const sesProvider = {
  async sendOtpEmail(params: EmailOtpParams): Promise<OtpProviderResult> {
    if (sesCircuitBreaker.shouldSkip()) {
      return { success: false, error: 'SES temporarily unavailable' }
    }
    try {
      const body = buildOtpEmailBody(params.otp)
      const response = await sesClient.send(
        new SendEmailCommand({
          Source: fromEmail(),
          Destination: {
            ToAddresses: [params.email],
          },
          Message: {
            Subject: {
              Charset: 'UTF-8',
              Data: OTP_EMAIL_SUBJECT,
            },
            Body: {
              Text: {
                Charset: 'UTF-8',
                Data: body.text,
              },
              Html: {
                Charset: 'UTF-8',
                Data: body.html,
              },
            },
          },
        }),
      )
      sesCircuitBreaker.recordSuccess()

      return { success: true, providerMessageId: response.MessageId }
    } catch (error) {
      sesCircuitBreaker.recordFailure()
      return { success: false, error: errorMessage(error) }
    }
  },

  async sendTransactionalEmail(params: TransactionalEmailParams): Promise<OtpProviderResult> {
    const source = fromEmail()
    if (!source) {
      return { success: false, error: 'EMAIL_FROM / SES_FROM_EMAIL is not configured' }
    }
    if (sesCircuitBreaker.shouldSkip()) {
      return { success: false, error: 'SES temporarily unavailable' }
    }
    try {
      const response = await sesClient.send(
        new SendEmailCommand({
          Source: source,
          Destination: {
            ToAddresses: [params.email],
          },
          Message: {
            Subject: {
              Charset: 'UTF-8',
              Data: params.subject,
            },
            Body: {
              Text: {
                Charset: 'UTF-8',
                Data: params.text,
              },
              Html: {
                Charset: 'UTF-8',
                Data: params.html,
              },
            },
          },
        }),
      )
      sesCircuitBreaker.recordSuccess()
      return { success: true, providerMessageId: response.MessageId }
    } catch (error) {
      sesCircuitBreaker.recordFailure()
      return { success: false, error: errorMessage(error) }
    }
  },
}
