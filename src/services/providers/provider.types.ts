import type { OtpPurpose } from '../../models/types'

export type OtpProviderName = 'msg91_whatsapp' | 'msg91_sms' | 'ses_email'

export interface OtpProviderResult {
  success: boolean
  providerMessageId?: string
  error?: string
}

export interface OtpProviderBaseParams {
  otp: string
  purpose: OtpPurpose
}

export interface WhatsappOtpParams extends OtpProviderBaseParams {
  phone: string
  templateVariables?: Record<string, string>
}

export interface SmsOtpParams extends OtpProviderBaseParams {
  phone: string
  templateVariables?: Record<string, string>
}

export interface EmailOtpParams extends OtpProviderBaseParams {
  email: string
}
