/**
 * Relative "last online" formatting for presence UIs.
 * Uses seconds, minutes, or hours for recent activity; days for older.
 */
export type LastOnlineFields = {
  lastActiveAt: string | null
  lastOnlineSeconds: number | null
  lastOnlineLabel: string | null
}

export function formatLastOnline(
  lastActiveAt: Date | null | undefined,
  now: Date = new Date(),
): LastOnlineFields {
  if (!lastActiveAt) {
    return { lastActiveAt: null, lastOnlineSeconds: null, lastOnlineLabel: null }
  }

  const diffMs = Math.max(0, now.getTime() - lastActiveAt.getTime())
  const seconds = Math.floor(diffMs / 1000)
  const iso = lastActiveAt.toISOString()

  if (seconds < 10) {
    return { lastActiveAt: iso, lastOnlineSeconds: seconds, lastOnlineLabel: 'just now' }
  }
  if (seconds < 60) {
    return { lastActiveAt: iso, lastOnlineSeconds: seconds, lastOnlineLabel: `${seconds}s ago` }
  }

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return { lastActiveAt: iso, lastOnlineSeconds: seconds, lastOnlineLabel: `${minutes}m ago` }
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return { lastActiveAt: iso, lastOnlineSeconds: seconds, lastOnlineLabel: `${hours}h ago` }
  }

  const days = Math.floor(hours / 24)
  return { lastActiveAt: iso, lastOnlineSeconds: seconds, lastOnlineLabel: `${days}d ago` }
}

/** Device list helper — same buckets, slightly longer tail (weeks/months). */
export function formatLastActiveTimeAgo(date: Date, now: Date = new Date()): string {
  const { lastOnlineLabel } = formatLastOnline(date, now)
  if (!lastOnlineLabel) return 'unknown'

  const diffMs = Math.max(0, now.getTime() - date.getTime())
  const days = Math.floor(diffMs / 86400000)
  if (days >= 7 && days < 30) return `${Math.floor(days / 7)}w ago`
  if (days >= 30) return `${Math.floor(days / 30)}mo ago`
  return lastOnlineLabel
}
