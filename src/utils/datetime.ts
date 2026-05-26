/**
 * UTC calendar helpers — no external timezone library.
 */

import { AppError } from "../middlewares/errorHandler";

export function utcNow(): Date {
  return new Date();
}

export function utcYearMonth(d: Date): { year: number; month: number } {
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
  };
}

/** Start of UTC month (inclusive) and first instant of the following month (exclusive). */
export function utcMonthBoundsExclusive(
  year: number,
  month: number,
): { start: Date; endExclusive: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endExclusive = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return { start, endExclusive };
}

/** Previous calendar month in UTC relative to `d`. */
export function utcPreviousYearMonth(d: Date): { year: number; month: number } {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (m === 1) return { year: y - 1, month: 12 };
  return { year: y, month: m - 1 };
}

/** UTC calendar date as `YYYY-MM-DD` (for daily VIP claim idempotency). */
export function utcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

/** Add whole UTC calendar days to `from` (no external deps). */
export function addUtcDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Midnight UTC for the given instant's calendar date. */
export function utcStartOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

/** Calendar UTC date only (for agency_daily_earnings.day) from a timestamp. */
export function utcDayFromTimestamp(d: Date): Date {
  return utcStartOfDay(d);
}

/**
 * Rolling window for agency level: last 30 fully elapsed UTC calendar days
 * ending yesterday — `[fromDay, toDay]` inclusive as DATE values.
 */
export function agencyCommissionRollingWindowDays(now: Date = utcNow()): {
  fromDay: Date;
  toDay: Date;
} {
  const todayStart = utcStartOfDay(now);
  const toDay = addUtcDays(todayStart, -1);
  const fromDay = addUtcDays(todayStart, -30);
  return { fromDay, toDay };
}

/** Inclusive UTC calendar day range ending yesterday (`periodDays` days). */
export function utcRollingPeriodDays(
  periodDays: number,
  now: Date = utcNow(),
): { fromDay: Date; toDay: Date } {
  const yesterday = addUtcDays(utcStartOfDay(now), -1);
  const fromDay = addUtcDays(yesterday, -(periodDays - 1));
  return { fromDay, toDay: yesterday };
}

function parseUtcDate(s: string): Date {
  const [year, month, day] = s.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

/**
 * Resolves a commission query period from either:
 *   - periodDays (integer, rolling window ending yesterday)
 *   - from + to (ISO date strings, inclusive UTC calendar days)
 *
 * Returns { start: Date (UTC midnight), end: Date (UTC midnight, inclusive) }
 */
export function resolveCommissionPeriod(params: {
  periodDays?: number;
  from?: string;
  to?: string;
}): { start: Date; end: Date } {
  if (params.from && params.to) {
    const start = parseUtcDate(params.from);
    const end = parseUtcDate(params.to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new AppError(400, "Invalid date format. Use YYYY-MM-DD", "INVALID_DATE_RANGE");
    }
    if (end < start) {
      throw new AppError(400, '"to" must be on or after "from"', "INVALID_DATE_RANGE");
    }
    const maxRangeMs = 365 * 24 * 60 * 60 * 1000;
    if (end.getTime() - start.getTime() > maxRangeMs) {
      throw new AppError(400, "Date range cannot exceed 365 days", "DATE_RANGE_TOO_LARGE");
    }
    return { start, end };
  }

  const periodDays = params.periodDays ?? 30;
  const { fromDay, toDay } = utcRollingPeriodDays(periodDays);
  return { start: fromDay, end: toDay };
}

/** Half-open ledger bounds `[from, toExclusive)` for an inclusive UTC calendar day range. */
export function commissionPeriodToLedgerBounds(
  start: Date,
  end: Date,
): { from: Date; toExclusive: Date } {
  return { from: start, toExclusive: addUtcDays(end, 1) };
}
