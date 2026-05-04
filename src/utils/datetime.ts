/**
 * UTC calendar helpers — no external timezone library.
 */

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
