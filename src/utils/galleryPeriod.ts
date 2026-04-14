/**
 * UTC calendar month boundaries for the global gift gallery.
 * Gallery is active from the 1st 00:00:00.000 UTC through the last moment of the month.
 */

export function getActivePeriod(now: Date = new Date()): {
  year: number
  month: number
  periodStart: Date
  periodEnd: Date
  secondsRemaining: number
} {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1

  const periodStart = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0))
  const periodEnd = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0) - 1)

  const secondsRemaining = Math.max(
    0,
    Math.floor((periodEnd.getTime() - now.getTime()) / 1000),
  )

  return { year, month, periodStart, periodEnd, secondsRemaining }
}

export function getMonthEndIso(now: Date = new Date()): string {
  const { periodEnd } = getActivePeriod(now)
  return periodEnd.toISOString()
}
