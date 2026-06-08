import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import type { OtpPurpose } from '../models/types'
import { rootLogger } from '../utils/rootLogger'
import { auditService } from './audit.service'
import { msg91Provider } from './providers/msg91.provider'
import { sesProvider } from './providers/ses.provider'
import type { OtpProviderName, OtpProviderResult } from './providers/provider.types'

type OtpTarget =
  | { type: 'email'; value: string; masked: string }
  | { type: 'phone'; value: string; providerPhone: string; masked: string }

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const maskedLocal =
    local.length <= 2 ? `${local[0] ?? '*'}***` : `${local.slice(0, 2)}***${local.slice(-1)}`
  return `${maskedLocal}@${domain}`
}

function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '')
  if (digits.length <= 4) return '****'
  return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`
}

function normalizePhoneTarget(input: string): string | null {
  const cleaned = input.trim().replace(/[\s\-().]/g, '')
  const candidates = cleaned.startsWith('+')
    ? [cleaned]
    : cleaned.length === 10
      ? [`+91${cleaned}`]
      : [`+${cleaned}`]

  for (const candidate of candidates) {
    if (isValidPhoneNumber(candidate)) {
      return parsePhoneNumber(candidate).number as string
    }
  }

  return null
}

export function detectOtpTarget(targetIdentifier: string): OtpTarget {
  const trimmed = targetIdentifier.trim()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    const value = trimmed.toLowerCase()
    return { type: 'email', value, masked: maskEmail(value) }
  }

  const phone = normalizePhoneTarget(trimmed)
  if (phone) {
    return {
      type: 'phone',
      value: phone,
      providerPhone: phone.replace(/^\+/, ''),
      masked: maskPhone(phone),
    }
  }

  throw new AppError(400, 'Unsupported OTP target identifier', 'INVALID_OTP_TARGET')
}

export function maskOtpTargetIdentifier(targetIdentifier: string): string {
  try {
    return detectOtpTarget(targetIdentifier).masked
  } catch {
    return 'unrecognized'
  }
}

function auditDelivery(params: {
  actionType: string
  status: 'success' | 'failed'
  provider?: OtpProviderName
  purpose: OtpPurpose
  target: string
  messageId?: string
  error?: string
}) {
  auditService.log({
    actionType: params.actionType,
    actionStatus: params.status,
    actionDetails: {
      provider: params.provider,
      purpose: params.purpose,
      target: params.target,
      messageId: params.messageId,
      error: params.error,
    },
  })
}

function logProviderResult(params: {
  provider: OtpProviderName
  purpose: OtpPurpose
  target: string
  result: OtpProviderResult
}) {
  const logPayload = {
    provider: params.provider,
    purpose: params.purpose,
    target: params.target,
    providerMessageId: params.result.providerMessageId,
    error: params.result.error,
  }
  if (params.result.success) {
    rootLogger.info(logPayload, 'OTP delivery provider succeeded')
  } else {
    rootLogger.warn(logPayload, 'OTP delivery provider failed')
  }
}

export const otpDeliveryService = {
  async send(params: {
    otp: string
    targetIdentifier: string
    purpose: OtpPurpose
  }): Promise<void> {
    const target = detectOtpTarget(params.targetIdentifier)

    if (!env.OTP_DELIVERY_ENABLED) {
      rootLogger.debug(
        {
          purpose: params.purpose,
          target: target.masked,
          targetType: target.type,
        },
        'OTP delivery disabled; skipping provider send',
      )
      return
    }

    if (target.type === 'email') {
      const result = await sesProvider.sendOtpEmail({
        email: target.value,
        otp: params.otp,
        purpose: params.purpose,
      })
      logProviderResult({
        provider: 'ses_email',
        purpose: params.purpose,
        target: target.masked,
        result,
      })
      if (result.success) {
        auditDelivery({
          actionType: 'OTP_EMAIL_SENT',
          status: 'success',
          provider: 'ses_email',
          purpose: params.purpose,
          target: target.masked,
          messageId: result.providerMessageId,
        })
        return
      }

      auditDelivery({
        actionType: 'OTP_DELIVERY_FAILED',
        status: 'failed',
        provider: 'ses_email',
        purpose: params.purpose,
        target: target.masked,
        error: result.error,
      })
      throw new AppError(502, 'OTP delivery failed', 'OTP_DELIVERY_FAILED')
    }

    const whatsappResult = await msg91Provider.sendWhatsappOtp({
      phone: target.providerPhone,
      otp: params.otp,
      purpose: params.purpose,
    })
    logProviderResult({
      provider: 'msg91_whatsapp',
      purpose: params.purpose,
      target: target.masked,
      result: whatsappResult,
    })
    if (whatsappResult.success) {
      auditDelivery({
        actionType: 'OTP_WHATSAPP_SENT',
        status: 'success',
        provider: 'msg91_whatsapp',
        purpose: params.purpose,
        target: target.masked,
        messageId: whatsappResult.providerMessageId,
      })
      return
    }

    const smsResult = await msg91Provider.sendSmsOtp({
      phone: target.providerPhone,
      otp: params.otp,
      purpose: params.purpose,
    })
    logProviderResult({
      provider: 'msg91_sms',
      purpose: params.purpose,
      target: target.masked,
      result: smsResult,
    })
    if (smsResult.success) {
      auditDelivery({
        actionType: 'OTP_SMS_SENT',
        status: 'success',
        provider: 'msg91_sms',
        purpose: params.purpose,
        target: target.masked,
        messageId: smsResult.providerMessageId,
      })
      return
    }

    auditDelivery({
      actionType: 'OTP_DELIVERY_FAILED',
      status: 'failed',
      provider: 'msg91_sms',
      purpose: params.purpose,
      target: target.masked,
      error: smsResult.error ?? whatsappResult.error,
    })
    throw new AppError(502, 'OTP delivery failed', 'OTP_DELIVERY_FAILED')
  },
}
