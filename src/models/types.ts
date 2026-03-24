/**
 * Auth domain types – branded where useful, aligned with Prisma and API.
 */

export type UserId = string & { readonly __brand: 'UserId' }
export type SessionId = string & { readonly __brand: 'SessionId' }
export type RefreshToken = string & { readonly __brand: 'RefreshToken' }

export const AUTH_PROVIDERS = ['email', 'phone', 'google', 'facebook', 'apple'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

export const OTP_PURPOSES = [
  'signup',
  'login',
  'reset_password',
  'set_security_password',
  'bind_email',
  'bind_phone',
  'modify_email',
  'modify_phone',
] as const
export type OtpPurpose = (typeof OTP_PURPOSES)[number]

export const USER_STATUSES = ['new', 'active', 'suspended', 'deactivating', 'deleted'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

export interface JwtAccessPayload {
  userId: string
  publicId: number
  passwordSet: boolean
  jti: string
  /** Hardware device id; used for device management (current device). */
  deviceId?: string
  iat: number
  exp: number
}

export interface JwtRefreshPayload {
  userId: string
  sessionId: string
  jti: string
  iat: number
  exp: number
}

export interface AuthIdentifierView {
  provider: AuthProvider
  identifier: string
  isVerified: boolean
  verifiedAt: string | null
  isPrimary: boolean
}

export interface SessionView {
  sessionId: string
  deviceName: string
  deviceId: string
  isCurrentDevice: boolean
  lastActiveAt: string
  ipAddress: string
  loginType?: string
}

export interface AuthSettingsResponse {
  userId: string
  publicId: number
  passwordSet: boolean
  authIdentifiers: AuthIdentifierView[]
  activeSessions: SessionView[]
}

export interface LoginSuccessResponse {
  userId: string
  publicId: number
  status: UserStatus
  accessToken: string
  refreshToken: string
  passwordSet: boolean
  sessionId?: string
  nextStep?: 'complete_profile'
}

export interface CheckAvailabilityResponse {
  exists: boolean
  authMethods?: AuthProvider[]
  canSignup?: boolean
}
