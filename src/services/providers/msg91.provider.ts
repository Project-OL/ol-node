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

function buildWhatsappTemplateVariables(
  otp: string,
  purpose: string,
  templateVariables?: Record<string, string>,
): Record<string, string> {
  return {
    VAR1: otp,
    OTP: otp,
    purpose,
    ...(templateVariables ?? {}),
  }
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

export const msg91Provider = {
  async sendWhatsappOtp(params: WhatsappOtpParams): Promise<OtpProviderResult> {
    try {
      const variables = buildWhatsappTemplateVariables(
        params.otp,
        params.purpose,
        params.templateVariables,
      )
      const response = await msg91Client.post(
        '/api/v5/whatsapp/whatsapp-outbound-message/bulk/',
        {
          integrated_number: env.MSG91_WHATSAPP_SENDER,
          content_type: 'template',
          payload: {
            to: params.phone,
            type: 'template',
            template: {
              name: env.MSG91_WHATSAPP_TEMPLATE_ID,
              language: { code: 'en' },
              components: [
                {
                  type: 'body',
                  parameters: Object.values(variables).map((value) => ({
                    type: 'text',
                    text: value,
                  })),
                },
              ],
            },
          },
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
