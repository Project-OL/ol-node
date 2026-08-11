/**
 * Legal / profile `name` for API responses: trimmed first + last joined by a space.
 * Empty string when both parts are missing (does not fall back to username).
 */
export function formatUserName(user: {
  firstName?: string | null
  lastName?: string | null
}): string {
  const a = user.firstName?.trim()
  const b = user.lastName?.trim()
  return [a, b].filter((x): x is string => Boolean(x && x.length > 0)).join(' ')
}

/** First + last name when present; otherwise username. */
export function buildUserDisplayName(user: {
  username: string
  firstName: string | null
  lastName: string | null
}): string {
  const trimmed = formatUserName(user)
  return trimmed.length > 0 ? trimmed : user.username
}

/** Visible public id with rare/VIP overlay — same rule as `GET /users/me`. */
export function resolveDisplayPublicId(user: {
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
}): string {
  return String(user.currentVipPublicId ?? user.defaultPublicId ?? user.publicId)
}
