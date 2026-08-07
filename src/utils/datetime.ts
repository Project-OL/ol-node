/**
 * UTC calendar helpers — no external timezone library.
 */

import { AppError } from '../middlewares/errorHandler'

export function utcNow(): Date {
  return new Date()
}

export function utcYearMonth(d: Date): { year: number; month: number } {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
  }
}

/** Start of UTC month (inclusive) and first instant of the following month (exclusive). */
export function utcMonthBoundsExclusive(
  year: number,
  month: number,
): { start: Date; endExclusive: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0))
  const endExclusive = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0))
  return { start, endExclusive }
}

/** Previous calendar month in UTC relative to `d`. */
export function utcPreviousYearMonth(d: Date): { year: number; month: number } {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  if (m === 1) return { year: y - 1, month: 12 }
  return { year: y, month: m - 1 }
}

/** UTC calendar date as `YYYY-MM-DD` (for daily VIP claim idempotency). */
export function utcDateString(d: Date): string {
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${mo}-${day}`
}

/** Add whole UTC calendar days to `from` (no external deps). */
export function addUtcDays(from: Date, days: number): Date {
  const d = new Date(from.getTime())
  d.setUTCDate(d.getUTCDate() + days)
  return d
}

/** Midnight UTC for the given instant's calendar date. */
export function utcStartOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

/** Calendar UTC date only (for agency_daily_earnings.day) from a timestamp. */
export function utcDayFromTimestamp(d: Date): Date {
  return utcStartOfDay(d)
}

/**
 * Rolling window for agency level: last 30 UTC calendar days **including today** —
 * `[fromDay, toDay]` inclusive as DATE values (`today−29` … `today`).
 * At UTC midnight the oldest day ages out and a new empty today enters.
 *
 * @deprecated Prefer `agencyCommissionConfigService.resolveRollingWindowDays()` —
 * window length is admin-configurable via `agency_commission_config`.
 */
export function agencyCommissionRollingWindowDays(now: Date = utcNow()): {
  fromDay: Date
  toDay: Date
} {
  return resolveAgencyCommissionRollingWindowDays({ days: 30, hours: 0, minutes: 0 }, now)
}

/**
 * Resolve inclusive UTC calendar-day window for agency tier recompute.
 * - Days-only (`hours==0 && minutes==0`): `today − (days−1)` … `today` (legacy 30 → today−29…today).
 * - Otherwise: days overlapping `[now − duration, now]` via `utcStartOfDay`.
 */
export function resolveAgencyCommissionRollingWindowDays(
  cfg: { days: number; hours: number; minutes: number },
  now: Date = utcNow(),
): { fromDay: Date; toDay: Date } {
  const days = Math.max(0, Math.floor(cfg.days))
  const hours = Math.max(0, Math.floor(cfg.hours))
  const minutes = Math.max(0, Math.floor(cfg.minutes))
  const todayStart = utcStartOfDay(now)
  const toDay = todayStart

  if (hours === 0 && minutes === 0) {
    const inclusiveDays = Math.max(1, days)
    const fromDay = addUtcDays(todayStart, -(inclusiveDays - 1))
    return { fromDay, toDay }
  }

  const totalMinutes = days * 24 * 60 + hours * 60 + minutes
  const durationMs = Math.max(1, totalMinutes) * 60_000
  const windowStart = new Date(now.getTime() - durationMs)
  const fromDay = utcStartOfDay(windowStart)
  return { fromDay, toDay }
}

/** Inclusive UTC calendar day range ending yesterday (`periodDays` days). */
export function utcRollingPeriodDays(
  periodDays: number,
  now: Date = utcNow(),
): { fromDay: Date; toDay: Date } {
  const yesterday = addUtcDays(utcStartOfDay(now), -1)
  const fromDay = addUtcDays(yesterday, -(periodDays - 1))
  return { fromDay, toDay: yesterday }
}

function parseUtcDate(s: string): Date {
  const [year, month, day] = s.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day!))
}

/**
 * Resolves a commission query period from either:
 *   - periodDays (integer, rolling window ending yesterday)
 *   - from + to (ISO date strings, inclusive UTC calendar days)
 *
 * Returns { start: Date (UTC midnight), end: Date (UTC midnight, inclusive) }
 */
export function resolveCommissionPeriod(params: {
  periodDays?: number
  from?: string
  to?: string
}): { start: Date; end: Date } {
  if (params.from && params.to) {
    const start = parseUtcDate(params.from)
    const end = parseUtcDate(params.to)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError(400, 'Invalid date format. Use YYYY-MM-DD', 'INVALID_DATE_RANGE')
    }
    if (end < start) {
      throw new AppError(400, '"to" must be on or after "from"', 'INVALID_DATE_RANGE')
    }
    const maxRangeMs = 365 * 24 * 60 * 60 * 1000
    if (end.getTime() - start.getTime() > maxRangeMs) {
      throw new AppError(400, 'Date range cannot exceed 365 days', 'DATE_RANGE_TOO_LARGE')
    }
    return { start, end }
  }

  const periodDays = params.periodDays ?? 30
  const { fromDay, toDay } = utcRollingPeriodDays(periodDays)
  return { start: fromDay, end: toDay }
}

/** Half-open ledger bounds `[from, toExclusive)` for an inclusive UTC calendar day range. */
export function commissionPeriodToLedgerBounds(
  start: Date,
  end: Date,
): { from: Date; toExclusive: Date } {
  return { from: start, toExclusive: addUtcDays(end, 1) }
}

// ── Agency dashboard period resolution ────────────────────────────────────────

/** `YYYY-MM-DD` in UTC for use with Postgres `DATE` columns. */
export function toUTCDateOnly(d: Date): string {
  return utcDateString(d)
}

/** First instant (00:00:00.000) of the UTC calendar day for `d`. */
export function startOfUTCDay(d: Date): Date {
  return utcStartOfDay(d)
}

/** Last instant (23:59:59.999) of the UTC calendar day for `d`. */
export function endOfUTCDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
}

export type DashboardPeriod = 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'LAST_30_DAYS'

/** Rolling / calendar windows for `GET /wallet/points/summary` earnings only. */
export type PointSummaryPeriod =
  | 'LAST_30_DAYS'
  | 'LAST_7_DAYS'
  | 'THIS_MONTH'
  | 'LAST_MONTH'
  | 'THIS_WEEK'
  | 'LAST_WEEK'

export interface DashboardPeriodQuery {
  period?: DashboardPeriod
  from?: string
  to?: string
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Resolves an agency dashboard query into an inclusive UTC instant range plus a
 * stable cache label.
 *
 * Precedence: an explicit custom range (`from`/`to`) wins over `period`.
 * Defaults to LAST_30_DAYS (today + prior 29 UTC days) when nothing supplied.
 *
 * Throws `AppError`:
 *   - 400 INVALID_DATE_RANGE   — only one of from/to, bad format, or from > to.
 *   - 400 DATE_RANGE_TOO_LARGE — custom range spans more than 365 days.
 */
export function resolveDashboardPeriod(q: DashboardPeriodQuery): {
  start: Date
  end: Date
  label: string
} {
  const now = utcNow()

  if (q.from || q.to) {
    if (!q.from || !q.to) {
      throw new AppError(
        400,
        'Both from and to are required for a custom range',
        'INVALID_DATE_RANGE',
      )
    }
    if (!YMD_RE.test(q.from) || !YMD_RE.test(q.to)) {
      throw new AppError(400, 'Invalid date format. Use YYYY-MM-DD', 'INVALID_DATE_RANGE')
    }
    const start = startOfUTCDay(new Date(`${q.from}T00:00:00.000Z`))
    const end = endOfUTCDay(new Date(`${q.to}T00:00:00.000Z`))
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError(400, 'Invalid date format. Use YYYY-MM-DD', 'INVALID_DATE_RANGE')
    }
    if (start > end) {
      throw new AppError(400, '"from" must be on or before "to"', 'INVALID_DATE_RANGE')
    }
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
    if (diffDays > 365) {
      throw new AppError(400, 'Date range cannot exceed 365 days', 'DATE_RANGE_TOO_LARGE')
    }
    return { start, end, label: `${q.from}_${q.to}` }
  }

  const period: DashboardPeriod = q.period ?? 'LAST_30_DAYS'

  switch (period) {
    case 'TODAY':
      return { start: startOfUTCDay(now), end: endOfUTCDay(now), label: 'TODAY' }
    case 'YESTERDAY': {
      const yesterday = addUtcDays(now, -1)
      return {
        start: startOfUTCDay(yesterday),
        end: endOfUTCDay(yesterday),
        label: 'YESTERDAY',
      }
    }
    case 'THIS_WEEK': {
      // Monday 00:00 UTC → end of today UTC.
      const dayOfWeek = now.getUTCDay() // 0=Sun, 1=Mon, …
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const monday = addUtcDays(now, -daysFromMonday)
      return { start: startOfUTCDay(monday), end: endOfUTCDay(now), label: 'THIS_WEEK' }
    }
    case 'THIS_MONTH': {
      const firstOfMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
      )
      return { start: firstOfMonth, end: endOfUTCDay(now), label: 'THIS_MONTH' }
    }
    case 'LAST_30_DAYS':
    default: {
      // Inclusive: today + prior 29 UTC days = 30 days total.
      const startDay = addUtcDays(now, -29)
      return { start: startOfUTCDay(startDay), end: endOfUTCDay(now), label: 'LAST_30_DAYS' }
    }
  }
}

/**
 * Resolves a point-summary earnings window (UTC). Balances are always all-time;
 * only the `earnings` bucket sums use this range when `period` is supplied.
 */
export function resolvePointSummaryPeriod(period: PointSummaryPeriod): {
  start: Date
  end: Date
  label: PointSummaryPeriod
} {
  const now = utcNow()

  switch (period) {
    case 'LAST_7_DAYS': {
      const startDay = addUtcDays(now, -6)
      return { start: startOfUTCDay(startDay), end: endOfUTCDay(now), label: period }
    }
    case 'THIS_WEEK': {
      const dayOfWeek = now.getUTCDay()
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const monday = addUtcDays(now, -daysFromMonday)
      return { start: startOfUTCDay(monday), end: endOfUTCDay(now), label: period }
    }
    case 'LAST_WEEK': {
      const dayOfWeek = now.getUTCDay()
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
      const thisMonday = addUtcDays(now, -daysFromMonday)
      const lastMonday = addUtcDays(thisMonday, -7)
      const lastSunday = addUtcDays(thisMonday, -1)
      return {
        start: startOfUTCDay(lastMonday),
        end: endOfUTCDay(lastSunday),
        label: period,
      }
    }
    case 'THIS_MONTH': {
      const firstOfMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
      )
      return { start: firstOfMonth, end: endOfUTCDay(now), label: period }
    }
    case 'LAST_MONTH': {
      const prev = utcPreviousYearMonth(now)
      const { start, endExclusive } = utcMonthBoundsExclusive(prev.year, prev.month)
      const lastDay = addUtcDays(endExclusive, -1)
      return { start, end: endOfUTCDay(lastDay), label: period }
    }
    case 'LAST_30_DAYS':
    default: {
      const startDay = addUtcDays(now, -29)
      return { start: startOfUTCDay(startDay), end: endOfUTCDay(now), label: 'LAST_30_DAYS' }
    }
  }
}
