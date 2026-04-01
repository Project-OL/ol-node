import type { MeGender } from '../utils/profileDisplay'

export interface MeResponseDto {
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

export interface PatchMeResponseDto {
  user: MeResponseDto
  accessToken: string
}
