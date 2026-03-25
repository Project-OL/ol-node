/** Display name shown in UI: "first last" if present, else username. */
export function displayNameFromUser(user: {
  firstName: string | null
  lastName: string | null
  username: string
}): string {
  const a = user.firstName?.trim()
  const b = user.lastName?.trim()
  const parts = [a, b].filter((x): x is string => Boolean(x && x.length > 0))
  if (parts.length > 0) return parts.join(' ')
  return user.username
}

export type MeGender = 'male' | 'female' | 'other'

export function normalizeGenderStored(raw: string | null | undefined): MeGender | null {
  if (raw == null || raw === '') return null
  const g = raw.toLowerCase()
  if (g === 'male' || g === 'female' || g === 'other') return g
  return null
}

/** Split display name into first + last (first space separates). */
export function splitDisplayName(name: string): { firstName: string; lastName: string | null } {
  const t = name.trim()
  const i = t.indexOf(' ')
  if (i === -1) return { firstName: t, lastName: null }
  return {
    firstName: t.slice(0, i).trim(),
    lastName: t.slice(i + 1).trim() || null,
  }
}
