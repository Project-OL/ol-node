/**
 * UTC period keys for fan spend / rankings (aligned with gift gallery month).
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
