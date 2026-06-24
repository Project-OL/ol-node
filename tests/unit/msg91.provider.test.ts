import { describe, it, expect, vi, beforeEach } from 'vitest'

const post = vi.fn()

vi.mock('axios', () => ({
  default: {
    create: () => ({ post }),
    isAxiosError: (error: unknown) =>
      Boolean(error && typeof error === 'object' && 'isAxiosError' in error),
  },
  isAxiosError: (error: unknown) =>
    Boolean(error && typeof error === 'object' && 'isAxiosError' in error),
}))

vi.mock('../../src/config/env', () => ({
  env: {
    MSG91_AUTH_KEY: 'test-auth-key',
    MSG91_WHATSAPP_SENDER: '918081551751',
    MSG91_WHATSAPP_TEMPLATE_ID: 'otp_delivery',
    MSG91_WHATSAPP_NAMESPACE: 'test_namespace_id',
    MSG91_WHATSAPP_LANGUAGE_CODE: 'en',
    MSG91_SMS_TEMPLATE_ID: 'sms-template',
    MSG91_SENDER_ID: 'SENDER',
    MSG91_DLT_ENTITY_ID: 'dlt-entity',
  },
}))

const { buildWhatsappOtpRequestBody, msg91Provider } = await import(
  '../../src/services/providers/msg91.provider'
)

describe('msg91.provider WhatsApp OTP', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    post.mockResolvedValue({ data: { request_id: 'wa-req-1' } })
  })

  it('buildWhatsappOtpRequestBody maps OTP to body_1 and button_1', () => {
    expect(
      buildWhatsappOtpRequestBody({
        phone: '919876543210',
        otp: '48291',
        integratedNumber: '918081551751',
        templateName: 'otp_delivery',
        languageCode: 'en',
        namespace: 'abc_namespace',
      }),
    ).toEqual({
      integrated_number: '918081551751',
      content_type: 'template',
      payload: {
        messaging_product: 'whatsapp',
        type: 'template',
        template: {
          name: 'otp_delivery',
          language: { code: 'en', policy: 'deterministic' },
          namespace: 'abc_namespace',
          to_and_components: [
            {
              to: ['919876543210'],
              components: {
                body_1: { type: 'text', value: '48291' },
                button_1: { subtype: 'url', type: 'text', value: '48291' },
              },
            },
          ],
        },
      },
    })
  })

  it('sets namespace to null when not provided (MSG91 otp_delivery default)', () => {
    const body = buildWhatsappOtpRequestBody({
      phone: '919876543210',
      otp: '48291',
      integratedNumber: '15559762402',
      templateName: 'otp_delivery',
      languageCode: 'en',
    })
    expect(body.payload.template).toMatchObject({ namespace: null })
  })

  it('sendWhatsappOtp posts MSG91 authentication template payload', async () => {
    const result = await msg91Provider.sendWhatsappOtp({
      phone: '919876543210',
      otp: '48291',
      purpose: 'signup',
    })

    expect(result).toEqual({ success: true, providerMessageId: 'wa-req-1' })
    expect(post).toHaveBeenCalledWith(
      '/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
      buildWhatsappOtpRequestBody({
        phone: '919876543210',
        otp: '48291',
        integratedNumber: '918081551751',
        templateName: 'otp_delivery',
        languageCode: 'en',
        namespace: 'test_namespace_id',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ authkey: 'test-auth-key' }),
      }),
    )
  })
})
