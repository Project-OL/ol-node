import { env } from '../../config/env'
import type {
  EmailOtpParams,
  EmailProviderName,
  OtpProviderResult,
  TransactionalEmailParams,
} from './provider.types'
import { resendProvider } from './resend.provider'
import { sesProvider } from './ses.provider'

/**
 * Single entry point for outbound email. EMAIL_PROVIDER picks the backend
 * (`ses` default, `resend`); callers record `emailProvider.name` in audits.
 */
const useResend = env.EMAIL_PROVIDER === 'resend'
const backend = useResend ? resendProvider : sesProvider

export const emailProvider: {
  name: EmailProviderName
  sendOtpEmail(params: EmailOtpParams): Promise<OtpProviderResult>
  sendTransactionalEmail(params: TransactionalEmailParams): Promise<OtpProviderResult>
} = {
  name: useResend ? 'resend_email' : 'ses_email',
  sendOtpEmail: (params) => backend.sendOtpEmail(params),
  sendTransactionalEmail: (params) => backend.sendTransactionalEmail(params),
}
