import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js'
import { env } from '../config/env'
import { OTP_SMS_PREFERRED_ROUTE_TTL_SEC, RedisKeys, redisClient } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import type { OtpPurpose } from '../models/types'
import { rootLogger } from '../utils/rootLogger'
import { auditService } from './audit.service'
import { msg91Provider } from './providers/msg91.provider'
import { sesProvider } from './providers/ses.provider'
import type { OtpProviderName, OtpProviderResult } from './providers/provider.types'

const otpDeliveryLog = rootLogger.child({ module: 'otp-delivery' })

type OtpDeliveryLogContext = {
  purpose: OtpPurpose
  target: string
  targetType: OtpTarget['type']
  deliveryProvider?: OtpProviderName
  providerMessageId?: string
  error?: string
  fallbackFrom?: OtpProviderName
  routeReason?: 'sms_preferred_route'
}

function logOtpDelivery(
  event:
    | 'otp_delivery_started'
    | 'otp_delivery_attempt'
    | 'otp_delivery_succeeded'
    | 'otp_delivery_failed'
    | 'otp_delivery_skipped'
    | 'otp_delivery_fallback',
  ctx: OtpDeliveryLogContext,
  level: 'debug' | 'info' | 'warn' | 'error' = 'info',
) {
  otpDeliveryLog[level]({ event, ...ctx }, `OTP delivery: ${event}`)
}

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
  targetType: OtpTarget['type']
  result: OtpProviderResult
}) {
  if (params.result.success) {
    logOtpDelivery(
      'otp_delivery_attempt',
      {
        purpose: params.purpose,
        target: params.target,
        targetType: params.targetType,
        deliveryProvider: params.provider,
        providerMessageId: params.result.providerMessageId,
      },
      'info',
    )
    return
  }

  logOtpDelivery(
    'otp_delivery_attempt',
    {
      purpose: params.purpose,
      target: params.target,
      targetType: params.targetType,
      deliveryProvider: params.provider,
      error: params.result.error,
    },
    'warn',
  )
}

function logDeliverySucceeded(params: {
  provider: OtpProviderName
  purpose: OtpPurpose
  target: string
  targetType: OtpTarget['type']
  providerMessageId?: string
  fallbackFrom?: OtpProviderName
  routeReason?: 'sms_preferred_route'
}) {
  if (params.fallbackFrom) {
    logOtpDelivery('otp_delivery_fallback', {
      purpose: params.purpose,
      target: params.target,
      targetType: params.targetType,
      deliveryProvider: params.provider,
      fallbackFrom: params.fallbackFrom,
      providerMessageId: params.providerMessageId,
      routeReason: params.routeReason,
    })
  }

  logOtpDelivery('otp_delivery_succeeded', {
    purpose: params.purpose,
    target: params.target,
    targetType: params.targetType,
    deliveryProvider: params.provider,
    providerMessageId: params.providerMessageId,
    fallbackFrom: params.fallbackFrom,
    routeReason: params.routeReason,
  })
}

async function isSmsPreferredRouteActive(providerPhone: string): Promise<boolean> {
  try {
    return (await redisClient.exists(RedisKeys.otpSmsPreferredRoute(providerPhone))) === 1
  } catch (err) {
    otpDeliveryLog.warn(
      { err, providerPhone: maskPhone(`+${providerPhone}`) },
      'OTP delivery: failed to read SMS-preferred route flag; defaulting to WhatsApp-first',
    )
    return false
  }
}

/** (Re)start the 2-minute SMS-only window — called after WhatsApp or SMS delivery. */
async function refreshSmsPreferredRoute(providerPhone: string): Promise<void> {
  try {
    await redisClient.set(
      RedisKeys.otpSmsPreferredRoute(providerPhone),
      '1',
      'EX',
      OTP_SMS_PREFERRED_ROUTE_TTL_SEC,
    )
  } catch (err) {
    otpDeliveryLog.warn(
      { err, providerPhone: maskPhone(`+${providerPhone}`) },
      'OTP delivery: failed to refresh SMS-preferred route window',
    )
  }
}

async function deliverPhoneOtpViaSms(params: {
  otp: string
  purpose: OtpPurpose
  target: Extract<OtpTarget, { type: 'phone' }>
  routeReason?: 'sms_preferred_route'
  fallbackFrom?: OtpProviderName
}): Promise<void> {
  const smsResult = await msg91Provider.sendSmsOtp({
    phone: params.target.providerPhone,
    otp: params.otp,
    purpose: params.purpose,
  })
  logProviderResult({
    provider: 'msg91_sms',
    purpose: params.purpose,
    target: params.target.masked,
    targetType: params.target.type,
    result: smsResult,
  })
  if (smsResult.success) {
    await refreshSmsPreferredRoute(params.target.providerPhone)
    logDeliverySucceeded({
      provider: 'msg91_sms',
      purpose: params.purpose,
      target: params.target.masked,
      targetType: params.target.type,
      providerMessageId: smsResult.providerMessageId,
      fallbackFrom: params.fallbackFrom,
      routeReason: params.routeReason,
    })
    auditDelivery({
      actionType: 'OTP_SMS_SENT',
      status: 'success',
      provider: 'msg91_sms',
      purpose: params.purpose,
      target: params.target.masked,
      messageId: smsResult.providerMessageId,
    })
    return
  }

  auditDelivery({
    actionType: 'OTP_DELIVERY_FAILED',
    status: 'failed',
    provider: 'msg91_sms',
    purpose: params.purpose,
    target: params.target.masked,
    error: smsResult.error,
  })
  logOtpDelivery(
    'otp_delivery_failed',
    {
      purpose: params.purpose,
      target: params.target.masked,
      targetType: params.target.type,
      deliveryProvider: 'msg91_sms',
      error: smsResult.error,
      routeReason: params.routeReason,
    },
    'error',
  )
  throw new AppError(502, 'OTP delivery failed', 'OTP_DELIVERY_FAILED')
}

export const otpDeliveryService = {
  async send(params: {
    otp: string
    targetIdentifier: string
    purpose: OtpPurpose
  }): Promise<void> {
    const target = detectOtpTarget(params.targetIdentifier)

    if (!env.OTP_DELIVERY_ENABLED) {
      logOtpDelivery(
        'otp_delivery_skipped',
        {
          purpose: params.purpose,
          target: target.masked,
          targetType: target.type,
        },
        'debug',
      )
      return
    }

    logOtpDelivery('otp_delivery_started', {
      purpose: params.purpose,
      target: target.masked,
      targetType: target.type,
      deliveryProvider: target.type === 'email' ? 'ses_email' : 'msg91_whatsapp',
    })

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
        targetType: target.type,
        result,
      })
      if (result.success) {
        logDeliverySucceeded({
          provider: 'ses_email',
          purpose: params.purpose,
          target: target.masked,
          targetType: target.type,
          providerMessageId: result.providerMessageId,
        })
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
      logOtpDelivery(
        'otp_delivery_failed',
        {
          purpose: params.purpose,
          target: target.masked,
          targetType: target.type,
          deliveryProvider: 'ses_email',
          error: result.error,
        },
        'error',
      )
      throw new AppError(502, 'OTP delivery failed', 'OTP_DELIVERY_FAILED')
    }

    if (target.type !== 'phone') {
      return
    }

    const preferSmsOnly = await isSmsPreferredRouteActive(target.providerPhone)
    if (preferSmsOnly) {
      logOtpDelivery('otp_delivery_started', {
        purpose: params.purpose,
        target: target.masked,
        targetType: target.type,
        deliveryProvider: 'msg91_sms',
        routeReason: 'sms_preferred_route',
      })
      await deliverPhoneOtpViaSms({
        otp: params.otp,
        purpose: params.purpose,
        target,
        routeReason: 'sms_preferred_route',
      })
      return
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
      targetType: target.type,
      result: whatsappResult,
    })
    if (whatsappResult.success) {
      await refreshSmsPreferredRoute(target.providerPhone)
      logDeliverySucceeded({
        provider: 'msg91_whatsapp',
        purpose: params.purpose,
        target: target.masked,
        targetType: target.type,
        providerMessageId: whatsappResult.providerMessageId,
      })
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

    await deliverPhoneOtpViaSms({
      otp: params.otp,
      purpose: params.purpose,
      target,
      fallbackFrom: 'msg91_whatsapp',
    })
  },
}
