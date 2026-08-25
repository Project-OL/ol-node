/**
 * IST day/week/month windows anchored at 23:30 IST (18:00 UTC).
 * Must stay aligned with Live-server `calculate1130DateRanges` (host-stats).
 */

export type Ist1130Range = { start: Date; end: Date }

export type Ist1130DateRanges = {
  today: Ist1130Range
  thisWeek: Ist1130Range
  thisMonth: Ist1130Range
}

/** Same algorithm as Live-server `serviceLive.calculate1130DateRanges`. */
export function calculate1130DateRanges(nowDate: Date = new Date()): Ist1130DateRanges {
  const istOffsetMs = 5.5 * 3600 * 1000
  const istDate = new Date(nowDate.getTime() + istOffsetMs)

  const y = istDate.getUTCFullYear()
  const m = istDate.getUTCMonth()
  const d = istDate.getUTCDate()

  // 18:00 UTC on current IST calendar day = 23:30 IST that day
  const today2330Utc = new Date(Date.UTC(y, m, d, 18, 0, 0, 0))
  let todayStartUtc: Date
  let todayEndUtc: Date

  if (nowDate >= today2330Utc) {
    todayStartUtc = today2330Utc
    todayEndUtc = new Date(Date.UTC(y, m, d + 1, 18, 0, 0, 0))
  } else {
    todayStartUtc = new Date(Date.UTC(y, m, d - 1, 18, 0, 0, 0))
    todayEndUtc = today2330Utc
  }

  // This week: Sunday 23:30 IST → next Sunday 23:30 IST
  const dayOfWeek = istDate.getUTCDay() // 0 = Sunday
  let daysSinceSunday = dayOfWeek
  if (dayOfWeek === 0 && nowDate < today2330Utc) {
    daysSinceSunday = 7
  }
  const sundayStartUtc = new Date(todayStartUtc.getTime() - daysSinceSunday * 86400 * 1000)
  const weekStartUtc = new Date(
    Date.UTC(
      sundayStartUtc.getUTCFullYear(),
      sundayStartUtc.getUTCMonth(),
      sundayStartUtc.getUTCDate(),
      18,
      0,
      0,
      0,
    ),
  )
  const weekEndUtc = new Date(weekStartUtc.getTime() + 7 * 86400 * 1000)

  const monthStartUtc = new Date(Date.UTC(y, m, 1, 18, 0, 0, 0))
  const monthEndUtc = new Date(Date.UTC(y, m + 1, 1, 18, 0, 0, 0))

  return {
    today: { start: todayStartUtc, end: todayEndUtc },
    thisWeek: { start: weekStartUtc, end: weekEndUtc },
    thisMonth: { start: monthStartUtc, end: monthEndUtc },
  }
}

export function formatDurationHHMMSS(totalSeconds = 0): string {
  const secs = Math.max(0, Math.floor(Number(totalSeconds)) || 0)
  const hours = Math.floor(secs / 3600)
  const minutes = Math.floor((secs % 3600) / 60)
  const remainingSecs = secs % 60
  return [hours, minutes, remainingSecs].map((v) => String(v).padStart(2, '0')).join(':')
}

/** Decimal hours rounded to 1 place (admin Live Summary card). */
export function secondsToLiveHours(totalSeconds: number): number {
  const secs = Math.max(0, Math.floor(Number(totalSeconds)) || 0)
  return Math.round((secs / 3600) * 10) / 10
}
