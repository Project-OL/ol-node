export type ActiveGuardianUserDto = {
  userId: string
  publicId: string
  name: string
  avatarUrl: string | null
}

export type ActiveGuardianProfileDto = {
  guardianId: string
  guardianUserId: string
  guardianPublicId: string
  displayName: string
  avatarUrl: string | null
  tier: string
  purchasedAt: Date
  expiresAt: Date
  user: ActiveGuardianUserDto
}
