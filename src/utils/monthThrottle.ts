export function isSameUtcMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
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
