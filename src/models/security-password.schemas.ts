/**
 * Zod schemas for Security Password Management API.
 */

import { z } from 'zod'
import { passwordSchema } from './schemas'

const otpFiveDigits = /^\d{5}$/

export const getIdentifiersSchema = z.object({})

export const sendOtpSchema = z.object({
  identifierId: z.string().uuid('Invalid identifier ID'),
})

export const verifyOtpSchema = z.object({
  identifierId: z.string().uuid('Invalid identifier ID'),
  otp: z.string().regex(otpFiveDigits, 'OTP must be 5 digits'),
})

export const setPasswordSchema = z.object({
  resetToken: z.string().min(1, 'Reset token required'),
  newPassword: passwordSchema,
})

export const changeStartSchema = z.object({
  currentPassword: z.string().min(1, 'Current password required'),
})

export const changeSendOtpSchema = z.object({
  changeToken: z.string().min(1, 'Change token required'),
  identifierId: z.string().uuid('Invalid identifier ID'),
})

export const changeConfirmSchema = z.object({
  changeToken: z.string().min(1, 'Change token required'),
  otp: z.string().regex(otpFiveDigits, 'OTP must be 5 digits'),
  newPassword: passwordSchema,
})

export const resetPasswordSchema = z.object({
  identifierId: z.string().uuid('Invalid identifier ID'),
  otp: z.string().regex(otpFiveDigits, 'OTP must be 5 digits'),
  newPassword: passwordSchema,
})

export type GetIdentifiersBody = z.infer<typeof getIdentifiersSchema>
export type SendOtpBody = z.infer<typeof sendOtpSchema>
export type VerifyOtpBody = z.infer<typeof verifyOtpSchema>
export type SetPasswordBody = z.infer<typeof setPasswordSchema>
export type ChangeStartBody = z.infer<typeof changeStartSchema>
export type ChangeSendOtpBody = z.infer<typeof changeSendOtpSchema>
export type ChangeConfirmBody = z.infer<typeof changeConfirmSchema>
export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>
