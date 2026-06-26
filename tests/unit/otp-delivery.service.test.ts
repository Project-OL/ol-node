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

const redisExists = vi.fn().mockResolvedValue(0)
const redisSet = vi.fn().mockResolvedValue('OK')

vi.mock('../../src/config/redis', () => ({
  OTP_SMS_PREFERRED_ROUTE_TTL_SEC: 120,
  RedisKeys: {
    otpSmsPreferredRoute: (phone: string) => `otp:sms-preferred:${phone}`,
  },
  redisClient: {
    exists: (...args: unknown[]) => redisExists(...args),
    set: (...args: unknown[]) => redisSet(...args),
  },
}))

const envState = vi.hoisted(() => ({ OTP_DELIVERY_ENABLED: true }))

vi.mock('../../src/config/env', () => ({
  env: envState,
}))

const { detectOtpTarget, otpDeliveryService } =
  await import('../../src/services/otp-delivery.service')

describe('otpDeliveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    envState.OTP_DELIVERY_ENABLED = true
    redisExists.mockResolvedValue(0)
    redisSet.mockResolvedValue('OK')
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
    })
    expect(detectOtpTarget('919876543210')).toMatchObject({
      type: 'phone',
      value: '+919876543210',
      providerPhone: '919876543210',
    })
    expect(detectOtpTarget('+919876543210')).toMatchObject({
      type: 'phone',
      value: '+919876543210',
      providerPhone: '919876543210',
    })
  })

  it('sends phone OTP via WhatsApp when WhatsApp succeeds', async () => {
    await otpDeliveryService.send({
      otp: '12345',
      targetIdentifier: '+919876543210',
      purpose: 'login',
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
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_succeeded',
        deliveryProvider: 'msg91_whatsapp',
        purpose: 'login',
      }),
      expect.any(String),
    )
    expect(redisSet).toHaveBeenCalledWith(
      'otp:sms-preferred:919876543210',
      '1',
      'EX',
      120,
    )
  })

  it('uses SMS only while SMS-preferred window is active and extends TTL on each SMS', async () => {
    redisExists.mockResolvedValue(1)

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
    expect(redisSet).toHaveBeenCalledWith(
      'otp:sms-preferred:919876543210',
      '1',
      'EX',
      120,
    )
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_started',
        deliveryProvider: 'msg91_sms',
        routeReason: 'sms_preferred_route',
      }),
      expect.any(String),
    )
  })

  it('extends SMS-preferred window when WhatsApp falls back to SMS', async () => {
    whatsappSend.mockResolvedValue({ success: false, error: 'wa failed' })

    await otpDeliveryService.send({
      otp: '12345',
      targetIdentifier: '+919876543210',
      purpose: 'login',
    })

    expect(redisSet).toHaveBeenCalledWith(
      'otp:sms-preferred:919876543210',
      '1',
      'EX',
      120,
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
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_fallback',
        deliveryProvider: 'msg91_sms',
        fallbackFrom: 'msg91_whatsapp',
      }),
      expect.any(String),
    )
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_succeeded',
        deliveryProvider: 'msg91_sms',
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
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'otp_delivery_succeeded',
        deliveryProvider: 'ses_email',
        purpose: 'reset_password',
      }),
      expect.any(String),
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

    expect(whatsappSend).not.toHaveBeenCalled()
    expect(smsSend).not.toHaveBeenCalled()
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'OTP_DELIVERY_FAILED',
        actionStatus: 'failed',
        actionDetails: expect.objectContaining({ provider: 'ses_email' }),
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

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'OTP_DELIVERY_FAILED',
        actionStatus: 'failed',
      }),
    )
  })
})
