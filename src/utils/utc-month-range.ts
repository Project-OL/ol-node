/** UTC calendar month window: [start, end). Defaults to current UTC month. */
export function utcMonthRange(
  year?: number,
  month?: number,
): {
  year: number
  month: number
  from: Date
  to: Date
} {
  const now = new Date()
  const y = year ?? now.getUTCFullYear()
  const m = month ?? now.getUTCMonth() + 1
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0))
  const to = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
  return { year: y, month: m, from, to }
}
