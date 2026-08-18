import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js'
import { env } from '../config/env'
import {
  OTP_SMS_TRIGGER_AFTER_COUNT,
  OTP_SMS_TRIGGER_INTERVAL_SEC_DEFAULT,
  RedisKeys,
  redisClient,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import type { OtpPurpose } from '../models/types'
import { rootLogger } from '../utils/rootLogger'
import { auditService } from './audit.service'
import {
  meansFromProvider,
  otpDeliveryAuditService,
} from './otp-delivery-audit.service'
import { otpDeliveryConfigService } from './otp-delivery-config.service'
import { msg91Provider } from './providers/msg91.provider'
import { sesProvider } from './providers/ses.provider'
import type { OtpProviderName, OtpProviderResult } from './providers/provider.types'

const otpDeliveryLog = rootLogger.child({ module: 'otp-delivery' })

type SmsRouteReason = 'sms_request_threshold' | 'fallback_to_sms'

type OtpDeliveryLogContext = {
  purpose: OtpPurpose
  target: string
  targetType: OtpTarget['type']
  deliveryProvider?: OtpProviderName
  providerMessageId?: string
  error?: string
  fallbackFrom?: OtpProviderName
  routeReason?: SmsRouteReason
  requestCount?: number
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
  | { type: 'email'; value: string; masked: string; country: string | null }
  | {
      type: 'phone'
      value: string
      providerPhone: string
      masked: string
      /** ISO-3166-1 alpha-2 from libphonenumber when known. */
      country: string | null
    }

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

function normalizePhoneTarget(
  input: string,
): { e164: string; country: string | null } | null {
  const cleaned = input.trim().replace(/[\s\-().]/g, '')
  const candidates = cleaned.startsWith('+')
    ? [cleaned]
    : cleaned.length === 10
      ? [`+91${cleaned}`]
      : [`+${cleaned}`]

  for (const candidate of candidates) {
    if (isValidPhoneNumber(candidate)) {
      const parsed = parsePhoneNumber(candidate)
      return {
        e164: parsed.number as string,
        country: parsed.country ?? null,
      }
    }
  }

  return null
}

export function detectOtpTarget(targetIdentifier: string): OtpTarget {
  const trimmed = targetIdentifier.trim()
  if (/^[^\s@]+@[^\s@]+$/.test(trimmed)) {
    const value = trimmed.toLowerCase()
    return { type: 'email', value, masked: maskEmail(value), country: null }
  }

  const phone = normalizePhoneTarget(trimmed)
  if (phone) {
    return {
      type: 'phone',
      value: phone.e164,
      providerPhone: phone.e164.replace(/^\+/, ''),
      masked: maskPhone(phone.e164),
      country: phone.country,
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

const PHONE_SUCCESS_AUDIT: Record<'msg91_whatsapp' | 'msg91_sms', string> = {
  msg91_whatsapp: 'OTP_WHATSAPP_SENT',
  msg91_sms: 'OTP_SMS_SENT',
}

/**
 * One audit row per provider attempt (WhatsApp fail + SMS success is two rows).
 * Failed rows are not billed (`otpDeliveryAuditService.record` charges success only).
 */
function recordPhoneChannelAttempt(params: {
  userId?: string | null
  purpose: OtpPurpose
  target: Extract<OtpTarget, { type: 'phone' }>
  provider: 'msg91_whatsapp' | 'msg91_sms'
  result: OtpProviderResult
  fallbackFrom?: OtpProviderName
  routeReason?: SmsRouteReason
}) {
  if (params.result.success) {
    logDeliverySucceeded({
      provider: params.provider,
      purpose: params.purpose,
      target: params.target.masked,
      targetType: params.target.type,
      providerMessageId: params.result.providerMessageId,
      fallbackFrom: params.fallbackFrom,
      routeReason: params.routeReason,
    })
    auditDelivery({
      actionType: PHONE_SUCCESS_AUDIT[params.provider],
      status: 'success',
      provider: params.provider,
      purpose: params.purpose,
      target: params.target.masked,
      messageId: params.result.providerMessageId,
    })
  } else {
    auditDelivery({
      actionType: 'OTP_DELIVERY_FAILED',
      status: 'failed',
      provider: params.provider,
      purpose: params.purpose,
      target: params.target.masked,
      error: params.result.error,
    })
  }

  otpDeliveryAuditService.record({
    userId: params.userId,
    purpose: params.purpose,
    means: meansFromProvider(params.provider),
    provider: params.provider,
    status: params.result.success ? 'success' : 'failed',
    targetType: 'phone',
    targetMasked: params.target.masked,
    country: params.target.country,
    providerMessageId: params.result.providerMessageId,
    fallbackFrom: params.fallbackFrom,
    routeReason: params.routeReason,
    error: params.result.success ? undefined : params.result.error,
  })
}

function logDeliverySucceeded(params: {
  provider: OtpProviderName
  purpose: OtpPurpose
  target: string
  targetType: OtpTarget['type']
  providerMessageId?: string
  fallbackFrom?: OtpProviderName
  routeReason?: SmsRouteReason
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

/**
 * Increment per-phone OTP request count within the SMS-trigger window.
 * TTL is set only when the key is created (fixed window from first request).
 */
async function bumpPhoneOtpRequestCount(
  providerPhone: string,
  intervalSec: number,
): Promise<number> {
  const key = RedisKeys.otpPhoneRequestCount(providerPhone)
  try {
    const count = await redisClient.incr(key)
    if (count === 1) {
      await redisClient.expire(key, intervalSec)
    }
    return count
  } catch (err) {
    otpDeliveryLog.warn(
      { err, providerPhone: maskPhone(`+${providerPhone}`) },
      'OTP delivery: failed to bump phone request count; defaulting to WhatsApp-first',
    )
    return 1
  }
}

async function deliverPhoneOtpViaSms(params: {
  otp: string
  purpose: OtpPurpose
  userId?: string | null
  target: Extract<OtpTarget, { type: 'phone' }>
  routeReason?: SmsRouteReason
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
  recordPhoneChannelAttempt({
    userId: params.userId,
    purpose: params.purpose,
    target: params.target,
    provider: 'msg91_sms',
    result: smsResult,
    fallbackFrom: params.fallbackFrom,
    routeReason: params.routeReason,
  })
  if (smsResult.success) {
    return
  }

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
    userId?: string | null
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
      otpDeliveryAuditService.record({
        userId: params.userId,
        purpose: params.purpose,
        means: 'none',
        provider: null,
        status: 'skipped',
        targetType: target.type,
        targetMasked: target.masked,
        country: target.country,
      })
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
        otpDeliveryAuditService.record({
          userId: params.userId,
          purpose: params.purpose,
          means: meansFromProvider('ses_email'),
          provider: 'ses_email',
          status: 'success',
          targetType: 'email',
          targetMasked: target.masked,
          country: target.country,
          providerMessageId: result.providerMessageId,
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
      otpDeliveryAuditService.record({
        userId: params.userId,
        purpose: params.purpose,
        means: meansFromProvider('ses_email'),
        provider: 'ses_email',
        status: 'failed',
        targetType: 'email',
        targetMasked: target.masked,
        country: target.country,
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

    const intervalSec =
      (await otpDeliveryConfigService.getSmsTriggerIntervalSec()) ||
      OTP_SMS_TRIGGER_INTERVAL_SEC_DEFAULT
    const requestCount = await bumpPhoneOtpRequestCount(target.providerPhone, intervalSec)
    const preferSms = requestCount >= OTP_SMS_TRIGGER_AFTER_COUNT

    if (preferSms) {
      logOtpDelivery('otp_delivery_started', {
        purpose: params.purpose,
        target: target.masked,
        targetType: target.type,
        deliveryProvider: 'msg91_sms',
        routeReason: 'sms_request_threshold',
        requestCount,
      })
      await deliverPhoneOtpViaSms({
        otp: params.otp,
        purpose: params.purpose,
        userId: params.userId,
        target,
        routeReason: 'sms_request_threshold',
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
    recordPhoneChannelAttempt({
      userId: params.userId,
      purpose: params.purpose,
      target,
      provider: 'msg91_whatsapp',
      result: whatsappResult,
      routeReason: whatsappResult.success ? undefined : 'fallback_to_sms',
    })
    if (whatsappResult.success) {
      return
    }

    await deliverPhoneOtpViaSms({
      otp: params.otp,
      purpose: params.purpose,
      userId: params.userId,
      target,
      fallbackFrom: 'msg91_whatsapp',
    })
  },
}
