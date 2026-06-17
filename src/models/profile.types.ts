export type ActiveGuardianUserDto = {
  userId: string
  publicId: string
  displayPublicId: string
  name: string
  avatarUrl: string | null
}

export type ActiveGuardianProfileDto = {
  guardianId: string
  guardianUserId: string
  guardianPublicId: string
  displayPublicId: string
  displayName: string
  avatarUrl: string | null
  tier: string
  purchasedAt: Date
  expiresAt: Date
  user: ActiveGuardianUserDto
}
