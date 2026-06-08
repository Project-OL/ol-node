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

vi.mock('../../src/utils/rootLogger', () => ({
  rootLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../src/config/env', () => ({
  env: {
    OTP_DELIVERY_ENABLED: true,
  },
}))

const { detectOtpTarget, otpDeliveryService } =
  await import('../../src/services/otp-delivery.service')

describe('otpDeliveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
    ).rejects.toMatchObject({ code: 'OTP_DELIVERY_FAILED' })

    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'OTP_DELIVERY_FAILED',
        actionStatus: 'failed',
      }),
    )
  })
})
