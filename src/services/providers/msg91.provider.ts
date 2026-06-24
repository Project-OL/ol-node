import axios, { AxiosError } from 'axios'
import { env } from '../../config/env'
import type { OtpProviderResult, SmsOtpParams, WhatsappOtpParams } from './provider.types'

const MSG91_BASE_URL = 'https://control.msg91.com'

const msg91Client = axios.create({
  baseURL: MSG91_BASE_URL,
  timeout: 10_000,
})

function msg91AuthHeaders() {
  return {
    authkey: env.MSG91_AUTH_KEY ?? '',
    'Content-Type': 'application/json',
  }
}

function extractProviderMessageId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const obj = data as Record<string, unknown>
  const candidates = [obj.request_id, obj.requestId, obj.message_id, obj.messageId, obj.id]
  const found = candidates.find((value) => typeof value === 'string' && value.length > 0)
  return found as string | undefined
}

function providerErrorMessage(error: AxiosError): string {
  const data = error.response?.data
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    const message = obj.message ?? obj.error ?? obj.msg
    if (typeof message === 'string') return message
  }
  return error.message
}

function isExpectedProviderError(error: unknown): error is AxiosError {
  return axios.isAxiosError(error)
}

/** MSG91 SMS template exposes a single placeholder named `var` for the OTP. */
function buildSmsTemplateVariables(
  otp: string,
  templateVariables?: Record<string, string>,
): Record<string, string> {
  return {
    var: otp,
    ...(templateVariables ?? {}),
  }
}

/**
 * MSG91 authentication templates (e.g. otp_delivery) expect OTP in body_1 and button_1.
 * @see https://msg91.com/help/whatsapp/whatsapp-otp
 */
export function buildWhatsappOtpRequestBody(params: {
  phone: string
  otp: string
  integratedNumber: string
  templateName: string
  languageCode: string
  namespace: string
}) {
  return {
    integrated_number: params.integratedNumber,
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: params.templateName,
        language: {
          code: params.languageCode,
          policy: 'deterministic',
        },
        namespace: params.namespace,
        to_and_components: [
          {
            to: [params.phone],
            components: {
              body_1: {
                type: 'text',
                value: params.otp,
              },
              button_1: {
                subtype: 'url',
                type: 'text',
                value: params.otp,
              },
            },
          },
        ],
      },
    },
  }
}

export const msg91Provider = {
  async sendWhatsappOtp(params: WhatsappOtpParams): Promise<OtpProviderResult> {
    try {
      const body = buildWhatsappOtpRequestBody({
        phone: params.phone,
        otp: params.otp,
        integratedNumber: env.MSG91_WHATSAPP_SENDER ?? '',
        templateName: env.MSG91_WHATSAPP_TEMPLATE_ID ?? '',
        languageCode: env.MSG91_WHATSAPP_LANGUAGE_CODE ?? 'en',
        namespace: env.MSG91_WHATSAPP_NAMESPACE ?? '',
      })
      const response = await msg91Client.post(
        '/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
        body,
        { headers: msg91AuthHeaders() },
      )

      return {
        success: true,
        providerMessageId: extractProviderMessageId(response.data),
      }
    } catch (error) {
      if (isExpectedProviderError(error)) {
        return { success: false, error: providerErrorMessage(error) }
      }
      throw error
    }
  },

  async sendSmsOtp(params: SmsOtpParams): Promise<OtpProviderResult> {
    try {
      const variables = buildSmsTemplateVariables(params.otp, params.templateVariables)
      const response = await msg91Client.post(
        '/api/v5/flow/',
        {
          template_id: env.MSG91_SMS_TEMPLATE_ID,
          sender: env.MSG91_SENDER_ID,
          short_url: '0',
          mobiles: params.phone,
          DLT_TE_ID: env.MSG91_DLT_ENTITY_ID,
          ...variables,
        },
        { headers: msg91AuthHeaders() },
      )

      return {
        success: true,
        providerMessageId: extractProviderMessageId(response.data),
      }
    } catch (error) {
      if (isExpectedProviderError(error)) {
        return { success: false, error: providerErrorMessage(error) }
      }
      throw error
    }
  },
}
