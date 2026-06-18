export function isSameUtcMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
}

/** Whether the user still has their one free display-name change this UTC calendar month. */
export function isFreeUsernameChangeAvailable(
  usernameUpdatedAt: Date | null,
  now: Date = new Date(),
): boolean {
  return usernameUpdatedAt == null || !isSameUtcMonth(usernameUpdatedAt, now)
}

/** `GET /users/me` fields for the monthly free username change allowance. */
export function freeUsernameChangeEligibility(
  usernameUpdatedAt: Date | string | null,
  now: Date = new Date(),
): { canChangeUsername: boolean; usernameNextChangeAt: string | null } {
  const updatedAt =
    usernameUpdatedAt == null
      ? null
      : typeof usernameUpdatedAt === 'string'
        ? new Date(usernameUpdatedAt)
        : usernameUpdatedAt
  if (isFreeUsernameChangeAvailable(updatedAt, now)) {
    return { canChangeUsername: true, usernameNextChangeAt: null }
  }
  return {
    canChangeUsername: false,
    usernameNextChangeAt: startOfNextUtcMonth(now).toISOString(),
  }
}

/** First instant of the next calendar month (UTC). */
export function startOfNextUtcMonth(from: Date = new Date()): Date {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

/** Whole seconds until `startOfNextUtcMonth(from)`. */
export function secondsUntilNextUtcMonth(from: Date = new Date()): number {
  const next = startOfNextUtcMonth(from)
  return Math.max(1, Math.ceil((next.getTime() - from.getTime()) / 1000))
}
