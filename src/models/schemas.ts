/**
 * Zod schemas for auth API – validation for all request bodies and query params.
 */

import { z } from 'zod'
import { PostVisibility } from '@prisma/client'
import { phoneSchema } from '../lib/schemas/phone.schema'

/** Re-export for services that validate phones with the same rules as auth bodies. */
export { phoneSchema }

const otpFiveDigits = /^\d{5}$/

export const providerEmailPhoneSchema = z.enum(['email', 'phone'])
export const providerWithPublicIdSchema = z.enum(['email', 'phone', 'publicId'])

export const emailSchema = z.string().email('Invalid email format')
export const publicIdSchema = z.union([z.string().regex(/^\d+$/).transform(Number), z.number()]).pipe(z.number().int().positive())

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain uppercase letter')
  .regex(/[a-z]/, 'Password must contain lowercase letter')
  .regex(/[0-9]/, 'Password must contain number')
  .regex(/[!@#$%^&*]/, 'Password must contain special character (!@#$%^&*)')

export const otpSchema = z
  .string()
  .length(5, 'OTP must be exactly 5 digits')
  .regex(otpFiveDigits, 'OTP must contain only numbers')

// Check availability
export const checkAvailabilityBodySchema = z.object({
  provider: providerEmailPhoneSchema,
  identifier: z.string().min(1),
})

// Signup send OTP
export const signupSendOtpBodySchema = z.object({
  provider: providerEmailPhoneSchema,
  identifier: z.string().min(1),
})

// Signup verify OTP
export const signupVerifyOtpBodySchema = z.object({
  provider: providerEmailPhoneSchema,
  identifier: z.string().min(1),
  otp: otpSchema,
})

// Signup create password
export const signupCreatePasswordBodySchema = z.object({
  provider: providerEmailPhoneSchema,
  identifier: z.string().min(1),
  password: passwordSchema,
})

// Signup complete profile (optional deviceId/deviceName: same stable id the app uses for POST /login/password)
export const completeProfileBodySchema = z
  .object({
    firstName: z.string().min(1).max(255),
    lastName: z.string().min(1).max(255),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    country: z.string().min(1).max(100),
    gender: z.enum(['male', 'female', 'other']),
    avatarUrl: z.string().url().optional().or(z.literal('')),
    /** Stable per-app-install id (e.g. UUID v4 in Keychain). Omit on web; send on mobile to match login. */
    deviceId: z.string().min(1).max(255).optional(),
    deviceName: z.string().min(1).max(255).optional(),
  })
  .refine((b) => Boolean(b.deviceId) === Boolean(b.deviceName), {
    message: 'deviceId and deviceName must both be provided or both omitted',
    path: ['deviceId'],
  })

// Login send OTP
export const loginSendOtpBodySchema = z.object({
  provider: providerEmailPhoneSchema,
  identifier: z.string().min(1),
})

// Login verify OTP
export const loginVerifyOtpBodySchema = z.object({
  provider: providerEmailPhoneSchema,
  identifier: z.string().min(1),
  otp: otpSchema,
  deviceName: z.string().min(1).max(255),
  deviceId: z.string().min(1).max(255),
})

// Login password (primary login for email/phone: no OTP — use check-availability first if needed)
export const loginPasswordBodySchema = z.object({
  provider: providerWithPublicIdSchema,
  identifier: z.string().min(1),
  password: z.string().min(1),
  deviceName: z.string().min(1).max(255),
  /** Same stable install id as complete-profile (e.g. UUID v4 persisted in secure storage). */
  deviceId: z.string().min(1).max(255),
})

// Refresh
export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
})

// Logout
export const logoutBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
}).optional()

// Password reset send OTP
export const passwordResetSendOtpBodySchema = z.object({
  identifier: z.string().min(1),
})

// Password reset send OTP to provider
export const passwordResetSendOtpToProviderBodySchema = z.object({
  identifier: z.string().min(1),
  provider: providerEmailPhoneSchema,
})

// Password reset verify OTP
export const passwordResetVerifyOtpBodySchema = z.object({
  identifier: z.string().min(1),
  provider: providerEmailPhoneSchema,
  otp: otpSchema,
})

// Password reset confirm
export const passwordResetConfirmBodySchema = z.object({
  resetToken: z.string().uuid(),
  newPassword: passwordSchema,
})

// Password set (OAuth user)
export const passwordSetBodySchema = z.object({
  password: passwordSchema,
})

// Password change
export const passwordChangeBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
})

// Email bind send OTP
export const emailBindSendOtpBodySchema = z.object({
  newEmail: emailSchema,
})

// Email bind verify OTP
export const emailBindVerifyOtpBodySchema = z.object({
  newEmail: emailSchema,
  otp: otpSchema,
})

// Email modify verify old (send OTP)
export const emailModifyVerifyOldBodySchema = z.object({
  currentEmail: emailSchema,
})

// Email modify verify old OTP (verify current email)
export const emailModifyVerifyOldOtpBodySchema = z.object({
  currentEmail: emailSchema,
  otp: otpSchema,
})

// Email modify verify new (optional otp: if missing send OTP, if present verify and update)
export const emailModifyVerifyNewBodySchema = z.object({
  newEmail: emailSchema,
  otp: otpSchema.optional(),
})

// Phone bind
export const phoneBindSendOtpBodySchema = z.object({
  newPhone: phoneSchema,
})
export const phoneBindVerifyOtpBodySchema = z.object({
  newPhone: phoneSchema,
  otp: otpSchema,
})

// Phone modify verify old (send OTP)
export const phoneModifyVerifyOldBodySchema = z.object({
  currentPhone: phoneSchema,
})

// Phone modify verify old OTP (verify current phone)
export const phoneModifyVerifyOldOtpBodySchema = z.object({
  currentPhone: phoneSchema,
  otp: otpSchema,
})

// Phone modify verify new (optional otp)
export const phoneModifyVerifyNewBodySchema = z.object({
  newPhone: phoneSchema,
  otp: otpSchema.optional(),
})

// Session revoke
export const sessionRevokeBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  revokeAllSessions: z.boolean().optional().default(false),
})

// OAuth (Google, Facebook, Apple)
export const oauthGoogleBodySchema = z.object({
  idToken: z.string().min(1),
  deviceName: z.string().min(1).max(255),
  deviceId: z.string().min(1).max(255),
})
export const oauthFacebookBodySchema = z.object({
  accessToken: z.string().min(1),
  deviceName: z.string().min(1).max(255),
  deviceId: z.string().min(1).max(255),
})
export const oauthAppleBodySchema = z.object({
  identityToken: z.string().min(1),
  deviceName: z.string().min(1).max(255),
  deviceId: z.string().min(1).max(255),
})

export type CheckAvailabilityBody = z.infer<typeof checkAvailabilityBodySchema>
export type SignupSendOtpBody = z.infer<typeof signupSendOtpBodySchema>
export type SignupVerifyOtpBody = z.infer<typeof signupVerifyOtpBodySchema>
export type SignupCreatePasswordBody = z.infer<typeof signupCreatePasswordBodySchema>
export type CompleteProfileBody = z.infer<typeof completeProfileBodySchema>
export type LoginSendOtpBody = z.infer<typeof loginSendOtpBodySchema>
export type LoginVerifyOtpBody = z.infer<typeof loginVerifyOtpBodySchema>
export type LoginPasswordBody = z.infer<typeof loginPasswordBodySchema>
export type RefreshBody = z.infer<typeof refreshBodySchema>
export type PasswordResetSendOtpBody = z.infer<typeof passwordResetSendOtpBodySchema>
export type PasswordResetConfirmBody = z.infer<typeof passwordResetConfirmBodySchema>
export type PasswordSetBody = z.infer<typeof passwordSetBodySchema>
export type PasswordChangeBody = z.infer<typeof passwordChangeBodySchema>
export type SessionRevokeBody = z.infer<typeof sessionRevokeBodySchema>

export const updateLanguageSchema = z.object({
  language: z.enum(['en', 'ne']),
})

export const updateMessagePrivacySchema = z
  .object({
    allowMsgFromMutual: z.boolean().optional(),
    allowMsgFromFollowing: z.boolean().optional(),
    allowMsgFromStranger: z.boolean().optional(),
  })
  .refine(
    (data) =>
      typeof data.allowMsgFromMutual === 'boolean' ||
      typeof data.allowMsgFromFollowing === 'boolean' ||
      typeof data.allowMsgFromStranger === 'boolean',
    { message: 'At least one field required' },
  )

export const updateLiveMicStatusSchema = z.object({
  hideMicStatus: z.boolean(),
})

export const unlinkDeviceAccountParamsSchema = z.object({
  targetUserId: z.string().min(1),
})

export const followParamSchema = z.object({
  targetUserId: z.string().min(1),
})

export const visitParamSchema = z.object({
  profileId: z.string().min(1),
})

export const userIdParamSchema = z.object({
  userId: z.string().min(1),
})

export const searchQuerySchema = z.object({
  publicId: z.string().min(1),
})

export const socialCursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const postUploadUrlSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
})

export const createPostSchema = z.object({
  mediaKey: z.string().min(1),
  caption: z.string().max(2000).optional(),
  visibility: z.nativeEnum(PostVisibility).default('SUBSCRIBERS_ONLY'),
  taggedUserIds: z.array(z.string().min(1)).max(10).optional(),
})

export const likeParamSchema = z.object({
  postId: z.string().min(1),
})

export const tagSearchQuerySchema = z.object({
  query: z.string().min(1).max(50),
})

export const postCursorQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const SOCIAL_SECTIONS = ['followers', 'following', 'friends', 'visitors'] as const
export type SocialSection = (typeof SOCIAL_SECTIONS)[number]

export const socialSummaryQuerySchema = z.object({
  include: z
    .string()
    .optional()
    .transform((s) =>
      s
        ? (s.split(',').map((x) => x.trim()).filter(Boolean) as SocialSection[])
        : ([...SOCIAL_SECTIONS] as SocialSection[]),
    )
    .pipe(
      z
        .array(z.enum(['followers', 'following', 'friends', 'visitors']))
        .min(1, 'At least one section required'),
    ),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export type SocialSummaryQuery = z.infer<typeof socialSummaryQuerySchema>
