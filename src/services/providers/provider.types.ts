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

export interface TransactionalEmailParams {
  email: string
  subject: string
  text: string
  html: string
}

export interface WhatsappTemplateParams {
  phone: string
  templateName: string
  bodyValues: string[]
}

export interface SmsTemplateParams {
  phone: string
  templateId: string
  templateVariables?: Record<string, string>
}
