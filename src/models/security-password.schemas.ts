/**
 * Zod schemas for Security Password Management API.
 */

import { z } from 'zod'

const otpFiveDigits = /^\d{5}$/

/** Numeric security PIN; no account-password strength rules. */
export const securityPinSchema = z
  .string()
  .regex(/^\d{4,8}$/, 'PIN must be 4 to 8 digits')

export const getIdentifiersSchema = z.object({})

export const sendOtpSchema = z.object({
  identifierId: z.string().uuid('Invalid identifier ID'),
})

export const verifyOtpSchema = z.object({
  identifierId: z.string().uuid('Invalid identifier ID'),
  otp: z.string().regex(otpFiveDigits, 'OTP must be 5 digits'),
})

/** Accept legacy `newPassword` key as alias for `newPin` (same 4–8 digit PIN rules). */
function normalizeSecuritySetBody(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw
  const o = { ...(raw as Record<string, unknown>) }
  if (o.newPin == null && typeof o.newPassword === 'string') {
    o.newPin = o.newPassword
  }
  return o
}

export const setPinSchema = z.preprocess(
  normalizeSecuritySetBody,
  z.object({
    resetToken: z.string().min(1, 'Reset token required'),
    newPin: securityPinSchema,
  }),
)

export const changePinSchema = z
  .object({
    currentPin: securityPinSchema,
    newPin: securityPinSchema,
  })
  .refine((data) => data.currentPin !== data.newPin, {
    message: 'New PIN must differ from current PIN',
    path: ['newPin'],
  })

export const resetPasswordSchema = z.object({
  identifierId: z.string().uuid('Invalid identifier ID'),
  otp: z.string().regex(otpFiveDigits, 'OTP must be 5 digits'),
  newPin: securityPinSchema,
})

export type GetIdentifiersBody = z.infer<typeof getIdentifiersSchema>
export type SendOtpBody = z.infer<typeof sendOtpSchema>
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>
export type SetPinBody = z.infer<typeof setPinSchema>
export type ChangePinBody = z.infer<typeof changePinSchema>
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>
