/**
 * Auth domain types – branded where useful, aligned with Prisma and API.
 */

export type UserId = string & { readonly __brand: 'UserId' }
export type SessionId = string & { readonly __brand: 'SessionId' }
export type RefreshToken = string & { readonly __brand: 'RefreshToken' }

export const AUTH_PROVIDERS = ['email', 'phone', 'google', 'facebook', 'apple'] as const
export type AuthProvider = (typeof AUTH_PROVIDERS)[number]

/** One linked auth method for POST /auth/check-availability when exists (raw identifier for client OTP / login flows). */
export interface CheckAvailabilityAuthIdentifier {
  provider: AuthProvider
  identifier: string
}

export type CheckAvailabilityResult =
  | { exists: false; authMethods: AuthProvider[] }
  | {
      exists: true
      authMethods: AuthProvider[]
      identifiers: CheckAvailabilityAuthIdentifier[]
      canSignup: false
      passwordSet: boolean
    }

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
  /** Standard JWT subject; same as userId when present. */
  sub?: string
  userId: string
  publicId: number
  passwordSet: boolean
  /** Display name for clients that decode the access token. */
  name?: string
  avatarUrl?: string | null
  jti?: string
  /** Hardware device id; used for device management (current device). */
  deviceId?: string
  /** Set after full session login; omitted on bootstrap tokens. */
  sessionId?: string
  /** Mirrors users.token_version at mint; global invalidation on password / revoke-all. */
  tokenVersion?: number
  /** Mirrors sessions.token_version at mint; bumped on refresh. */
  sessionTokenVersion?: number
  /** Customer support actor; mirrors `users.is_support` at mint. */
  isSupport?: boolean
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
