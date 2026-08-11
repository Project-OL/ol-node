/**
 * UTC period keys for fan spend / platform rankings (aligned with gift gallery month).
 */
export function getPeriodKeys(now = new Date()) {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  const d = now.getUTCDate()

  const dayKey = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  const dow = now.getUTCDay() || 7
  const monday = new Date(Date.UTC(y, m, d - (dow - 1)))
  const weekKey = monday.toISOString().slice(0, 10)

  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}-01`

  return { dayKey, weekKey, monthKey, year: y, month: m + 1 }
}

/** Last millisecond of calendar month (UTC). `month` is 1–12. */
export function getMonthEnd(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 1, 0, 0, 0, -1))
}

export type PlatformRankingPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY'

const DAY_MS = 24 * 60 * 60 * 1000
export const RANKING_HISTORY_MAX_DAYS = 90

/** Parse `YYYY-MM-DD` as UTC midnight; null if invalid. */
export function parseUtcDateKey(key: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [ys, ms, ds] = key.split('-')
  const y = Number(ys)
  const m = Number(ms)
  const d = Number(ds)
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null
  }
  return dt
}

function formatUtcDateKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Inclusive start / exclusive end UTC range for a ranking period bucket. */
export function rankingPeriodDayRange(
  period: PlatformRankingPeriod,
  periodKey: string,
): { startDay: Date; endDayExclusive: Date } | null {
  const start = parseUtcDateKey(periodKey)
  if (!start) return null

  if (period === 'DAILY') {
    return {
      startDay: start,
      endDayExclusive: new Date(start.getTime() + DAY_MS),
    }
  }
  if (period === 'WEEKLY') {
    // periodKey must be Monday (ISO week start used by getPeriodKeys).
    const dow = start.getUTCDay() || 7
    if (dow !== 1) return null
    return {
      startDay: start,
      endDayExclusive: new Date(start.getTime() + 7 * DAY_MS),
    }
  }
  // MONTHLY — periodKey is YYYY-MM-01
  if (start.getUTCDate() !== 1) return null
  const endDayExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  return { startDay: start, endDayExclusive }
}

/** Exclusive end instant for countdown (`endsAt`). */
export function rankingPeriodEndsAt(
  period: PlatformRankingPeriod,
  periodKey: string,
): Date | null {
  const range = rankingPeriodDayRange(period, periodKey)
  return range?.endDayExclusive ?? null
}

function oldestAllowedDay(now = new Date()): Date {
  const today = parseUtcDateKey(getPeriodKeys(now).dayKey)!
  return new Date(today.getTime() - (RANKING_HISTORY_MAX_DAYS - 1) * DAY_MS)
}

/** True when the period bucket is selectable within the last 90 UTC days. */
export function isRankingPeriodKeyAllowed(
  period: PlatformRankingPeriod,
  periodKey: string,
  now = new Date(),
): boolean {
  const range = rankingPeriodDayRange(period, periodKey)
  if (!range) return false
  const oldest = oldestAllowedDay(now)
  const current = getPeriodKeys(now)
  const currentKey =
    period === 'DAILY' ? current.dayKey : period === 'WEEKLY' ? current.weekKey : current.monthKey
  if (periodKey > currentKey) return false
  return range.endDayExclusive.getTime() > oldest.getTime()
}

export type RankingPeriodOption = {
  periodKey: string
  endsAt: string
  isCurrent: boolean
  label: string
}

/** List selectable period keys within the last 90 days (newest first). */
export function listRankingPeriodOptions(
  period: PlatformRankingPeriod,
  now = new Date(),
): RankingPeriodOption[] {
  const current = getPeriodKeys(now)
  const out: RankingPeriodOption[] = []
  const oldest = oldestAllowedDay(now)

  if (period === 'DAILY') {
    let cursor = parseUtcDateKey(current.dayKey)!
    while (cursor.getTime() >= oldest.getTime()) {
      const periodKey = formatUtcDateKey(cursor)
      const endsAt = rankingPeriodEndsAt('DAILY', periodKey)!
      out.push({
        periodKey,
        endsAt: endsAt.toISOString(),
        isCurrent: periodKey === current.dayKey,
        label: periodKey === current.dayKey ? 'Current Day' : periodKey,
      })
      cursor = new Date(cursor.getTime() - DAY_MS)
    }
    return out
  }

  if (period === 'WEEKLY') {
    let cursor = parseUtcDateKey(current.weekKey)!
    while (cursor.getTime() + 7 * DAY_MS > oldest.getTime()) {
      const periodKey = formatUtcDateKey(cursor)
      const endsAt = rankingPeriodEndsAt('WEEKLY', periodKey)!
      out.push({
        periodKey,
        endsAt: endsAt.toISOString(),
        isCurrent: periodKey === current.weekKey,
        label: periodKey === current.weekKey ? 'Current Week' : `Week of ${periodKey}`,
      })
      cursor = new Date(cursor.getTime() - 7 * DAY_MS)
      if (out.length > 20) break
    }
    return out
  }

  // MONTHLY
  let y = current.year
  let m = current.month
  for (let i = 0; i < 4; i++) {
    const periodKey = `${y}-${String(m).padStart(2, '0')}-01`
    const range = rankingPeriodDayRange('MONTHLY', periodKey)
    if (!range) break
    if (range.endDayExclusive.getTime() <= oldest.getTime() && periodKey !== current.monthKey) {
      break
    }
    const endsAt = rankingPeriodEndsAt('MONTHLY', periodKey)!
    out.push({
      periodKey,
      endsAt: endsAt.toISOString(),
      isCurrent: periodKey === current.monthKey,
      label: periodKey === current.monthKey ? 'Current Month' : periodKey.slice(0, 7),
    })
    m -= 1
    if (m < 1) {
      m = 12
      y -= 1
    }
  }
  return out
}

export function resolveRankingPeriodKey(
  period: PlatformRankingPeriod,
  periodKey: string | undefined,
  now = new Date(),
): string {
  const keys = getPeriodKeys(now)
  if (!periodKey) {
    if (period === 'DAILY') return keys.dayKey
    if (period === 'WEEKLY') return keys.weekKey
    return keys.monthKey
  }
  return periodKey
}
