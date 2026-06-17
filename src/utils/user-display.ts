/** First + last name when present; otherwise username. */
export function buildUserDisplayName(user: {
  username: string
  firstName: string | null
  lastName: string | null
}): string {
  const fullName =
    user.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : (user.firstName ?? user.lastName)
  const trimmed = fullName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : user.username
}

/** Visible public id with rare/VIP overlay — same rule as `GET /users/me`. */
export function resolveDisplayPublicId(user: {
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
}): string {
  return String(user.currentVipPublicId ?? user.defaultPublicId ?? user.publicId)
}
