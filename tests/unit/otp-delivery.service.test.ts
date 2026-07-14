import { describe, it, expect, vi, beforeEach } from 'vitest'

const whatsappSend = vi.fn()
const smsSend = vi.fn()
vi.mock('../../src/services/providers/msg91.provider', () => ({
  msg91Provider: {
    sendWhatsappOtp: (...args: unknown[]) => whatsappSend(...args),
    sendSmsOtp: (...args: unknown[]) => smsSend(...args),
  },
}))

const emailSend = vi.fn()
vi.mock('../../src/services/providers/ses.provider', () => ({
  sesProvider: {
    sendOtpEmail: (...args: unknown[]) => emailSend(...args),
  },
}))

const auditLog = vi.fn()
vi.mock('../../src/services/audit.service', () => ({
  auditService: {
    log: (...args: unknown[]) => auditLog(...args),
  },
}))

const deliveryAuditRecord = vi.fn()
vi.mock('../../src/services/otp-delivery-audit.service', () => ({
  meansFromProvider: (provider: string) => {
    if (provider === 'ses_email') return 'email'
    if (provider === 'msg91_whatsapp') return 'whatsapp'
    return 'sms'
  },
  otpDeliveryAuditService: {
    record: (...args: unknown[]) => deliveryAuditRecord(...args),
  },
}))

const logDebug = vi.fn()
const logInfo = vi.fn()
const logWarn = vi.fn()
const logError = vi.fn()

vi.mock('../../src/utils/rootLogger', () => ({
  rootLogger: {
    child: () => ({
      debug: logDebug,
      info: logInfo,
      warn: logWarn,
      error: logError,
    }),
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError,
  },
}))

const redisIncr = vi.fn().mockResolvedValue(1)
const redisExpire = vi.fn().mockResolvedValue(1)

vi.mock('../../src/config/redis', () => ({
  OTP_SMS_TRIGGER_AFTER_COUNT: 3,
  OTP_SMS_TRIGGER_INTERVAL_SEC_DEFAULT: 120,
  RedisKeys: {
    otpPhoneRequestCount: (phone: string) => `otp:phone-request-count:${phone}`,
  },
  redisClient: {
    incr: (...args: unknown[]) => redisIncr(...args),
    expire: (...args: unknown[]) => redisExpire(...args),
  },
}))

vi.mock('../../src/services/otp-delivery-config.service', () => ({
  otpDeliveryConfigService: {
    getSmsTriggerIntervalSec: vi.fn().mockResolvedValue(120),
  },
}))

const envState = vi.hoisted(() => ({
  OTP_DELIVERY_ENABLED: true,
  OTP_COST_CURRENCY: 'INR',
  OTP_COST_EMAIL_MINOR: 2,
  OTP_COST_WHATSAPP_MINOR: 25,
  OTP_COST_SMS_MINOR: 15,
}))

vi.mock('../../src/config/env', () => ({
  env: envState,
}))

const { detectOtpTarget, otpDeliveryService } =
  await import('../../src/services/otp-delivery.service')

describe('otpDeliveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envState.OTP_DELIVERY_ENABLED = true
    redisIncr.mockResolvedValue(1)
    redisExpire.mockResolvedValue(1)
    whatsappSend.mockResolvedValue({
      success: true,
      providerMessageId: 'wa-1',
    })
    smsSend.mockResolvedValue({ success: true, providerMessageId: 'sms-1' })
    emailSend.mockResolvedValue({ success: true, providerMessageId: 'ses-1' })
  })

  it('detects email identifiers', () => {
    expect(detectOtpTarget('Test@Example.com')).toMatchObject({
      type: 'email',
      value: 'test@example.com',
    })
  })

  it('detects Indian phone identifiers with supported input shapes', () => {
    expect(detectOtpTarget('9876543210')).toMatchObject({
      type: 'phone',
      value: '+919876543210',
      providerPhone: '919876543210',
      country: 'IN',
    })
    expect(detectOtpTarget('919876543210')).toMatchObject({
      type: 'phone',
      value: '+919876543210',
      providerPhone: '919876543210',
      country: 'IN',
    })
    expect(detectOtpTarget('+919876543210')).toMatchObject({
      type: 'phone',
      value: '+919876543210',
      providerPhone: '919876543210',
      country: 'IN',
    })
  })

  it('sends phone OTP via WhatsApp when WhatsApp succeeds', async () => {
    await otpDeliveryService.send({
      otp: '12345',
      targetIdentifier: '+919876543210',
      purpose: 'login',
      userId: '11111111-1111-1111-1111-111111111111',
    })

    expect(whatsappSend).toHaveBeenCalledWith({
      phone: '919876543210',
      otp: '12345',
      purpose: 'login',
    })
    expect(smsSend).not.toHaveBeenCalled()
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'OTP_WHATSAPP_SENT',
        actionStatus: 'success',
      }),
    )
    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'whatsapp',
        status: 'success',
        purpose: 'login',
        userId: '11111111-1111-1111-1111-111111111111',
      }),
    )
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_succeeded',
        deliveryProvider: 'msg91_whatsapp',
        purpose: 'login',
      }),
      expect.any(String),
    )
  })

  it('uses SMS when request count reaches SMS trigger threshold', async () => {
    redisIncr.mockResolvedValue(3)

    await otpDeliveryService.send({
      otp: '54321',
      targetIdentifier: '+919876543210',
      purpose: 'signup',
    })

    expect(whatsappSend).not.toHaveBeenCalled()
    expect(smsSend).toHaveBeenCalledWith({
      phone: '919876543210',
      otp: '54321',
      purpose: 'signup',
    })
    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'sms',
        status: 'success',
        routeReason: 'sms_request_threshold',
      }),
    )
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_started',
        deliveryProvider: 'msg91_sms',
        routeReason: 'sms_request_threshold',
      }),
      expect.any(String),
    )
  })

  it('falls back to SMS when WhatsApp delivery fails', async () => {
    whatsappSend.mockResolvedValue({
      success: false,
      error: 'template rejected',
    })

    await otpDeliveryService.send({
      otp: '12345',
      targetIdentifier: '9876543210',
      purpose: 'signup',
    })

    expect(whatsappSend).toHaveBeenCalledTimes(1)
    expect(smsSend).toHaveBeenCalledWith({
      phone: '919876543210',
      otp: '12345',
      purpose: 'signup',
    })
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'OTP_SMS_SENT',
        actionStatus: 'success',
      }),
    )
    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'sms',
        status: 'success',
        fallbackFrom: 'msg91_whatsapp',
      }),
    )
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_fallback',
        deliveryProvider: 'msg91_sms',
        fallbackFrom: 'msg91_whatsapp',
      }),
      expect.any(String),
    )
  })

  it('sends email OTP via SES', async () => {
    await otpDeliveryService.send({
      otp: '12345',
      targetIdentifier: 'test@example.com',
      purpose: 'reset_password',
    })

    expect(emailSend).toHaveBeenCalledWith({
      email: 'test@example.com',
      otp: '12345',
      purpose: 'reset_password',
    })
    expect(whatsappSend).not.toHaveBeenCalled()
    expect(smsSend).not.toHaveBeenCalled()
    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'email',
        status: 'success',
        purpose: 'reset_password',
      }),
    )
  })

  it('throws INVALID_OTP_TARGET for unsupported identifiers', () => {
    expect(() => detectOtpTarget('not-a-valid-target')).toThrow(
      expect.objectContaining({ code: 'INVALID_OTP_TARGET', statusCode: 400 }),
    )
  })

  it('skips provider send when OTP_DELIVERY_ENABLED is false', async () => {
    envState.OTP_DELIVERY_ENABLED = false

    await otpDeliveryService.send({
      otp: '12345',
      targetIdentifier: '+919876543210',
      purpose: 'signup',
    })

    expect(whatsappSend).not.toHaveBeenCalled()
    expect(smsSend).not.toHaveBeenCalled()
    expect(emailSend).not.toHaveBeenCalled()
    expect(auditLog).not.toHaveBeenCalled()
    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'none',
        status: 'skipped',
      }),
    )
    expect(logDebug).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'otp_delivery_skipped' }),
      expect.any(String),
    )
  })

  it('throws OTP_DELIVERY_FAILED when SES email delivery fails', async () => {
    emailSend.mockResolvedValue({ success: false, error: 'ses rejected' })

    await expect(
      otpDeliveryService.send({
        otp: '12345',
        targetIdentifier: 'fail@example.com',
        purpose: 'bind_email',
      }),
    ).rejects.toMatchObject({ code: 'OTP_DELIVERY_FAILED', statusCode: 502 })

    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'email',
        status: 'failed',
      }),
    )
  })

  it('throws OTP_DELIVERY_FAILED when all phone providers fail', async () => {
    whatsappSend.mockResolvedValue({
      success: false,
      error: 'whatsapp failed',
    })
    smsSend.mockResolvedValue({ success: false, error: 'sms failed' })

    await expect(
      otpDeliveryService.send({
        otp: '12345',
        targetIdentifier: '+919876543210',
        purpose: 'login',
      }),
    ).rejects.toMatchObject({ code: 'OTP_DELIVERY_FAILED', statusCode: 502 })

    expect(deliveryAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        means: 'sms',
        status: 'failed',
        fallbackFrom: 'msg91_whatsapp',
      }),
    )
  })
})
