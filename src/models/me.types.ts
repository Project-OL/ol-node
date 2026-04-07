import type { MeGender } from '../utils/profileDisplay'

export interface MeProfileCache {
  userId: string
  publicId: string
  name: string
  email: string
  avatarUrl: string | null
  bio: string | null
  /** Calendar date in UTC, `YYYY-MM-DD`, or `null` if unset. */
  dateOfBirth: string | null
  gender: MeGender | null
  canChangeUsername: boolean
  usernameNextChangeAt: string | null
}

export interface MeResponseDto extends MeProfileCache {
  /** Caller's current livestream level. */
  livestreamLevel: number
  /** Caller's current wealth level. */
  wealthLevel: number
  /** Caller's coin balance (serialised as string to avoid BigInt issues). */
  coinsBalance: string
  /** Caller's point balance (serialised as string to avoid BigInt issues). */
  pointsBalance: string
  /** Whether the caller currently has an active VIP subscription. */
  isVipActive: boolean
  /** ISO timestamp when the last VIP period started, or null if never had VIP. */
  lastVipStartedAt: string | null
  /** ISO timestamp when the last VIP period expires/expired, or null if never had VIP. */
  lastVipExpiresAt: string | null
}

export interface PatchMeResponseDto {
  user: MeResponseDto
  accessToken: string
}
