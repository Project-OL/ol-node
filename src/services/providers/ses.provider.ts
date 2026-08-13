import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses'
import { env } from '../../config/env'
import type { EmailOtpParams, OtpProviderResult } from './provider.types'
import { sesCircuitBreaker } from '../../utils/circuitBreaker'

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

function buildEmailBody(otp: string): { text: string; html: string } {
  const text = `Your OTP is:

${otp}

This OTP expires in 5 minutes.`

  const html = `
<!doctype html>
<html>
  <body>
    <p>Your OTP is:</p>
    <p style="font-size:24px;font-weight:700;letter-spacing:4px;">${otp}</p>
    <p>This OTP expires in 5 minutes.</p>
  </body>
</html>`.trim()

  return { text, html }
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
      const body = buildEmailBody(params.otp)
      const response = await sesClient.send(
        new SendEmailCommand({
          Source: env.SES_FROM_EMAIL,
          Destination: {
            ToAddresses: [params.email],
          },
          Message: {
            Subject: {
              Charset: 'UTF-8',
              Data: 'Your OffooLive Verification Code',
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
}
