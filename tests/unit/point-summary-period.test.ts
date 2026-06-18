import { describe, expect, it } from 'vitest'
import {
  addUtcDays,
  endOfUTCDay,
  resolvePointSummaryPeriod,
  startOfUTCDay,
  utcNow,
  utcPreviousYearMonth,
  utcMonthBoundsExclusive,
} from '../../src/utils/datetime'

describe('resolvePointSummaryPeriod', () => {
  const now = utcNow()

  it('LAST_30_DAYS spans today plus prior 29 UTC days', () => {
    const { start, end, label } = resolvePointSummaryPeriod('LAST_30_DAYS')
    expect(label).toBe('LAST_30_DAYS')
    expect(start).toEqual(startOfUTCDay(addUtcDays(now, -29)))
    expect(end).toEqual(endOfUTCDay(now))
  })

  it('LAST_7_DAYS spans today plus prior 6 UTC days', () => {
    const { start, end, label } = resolvePointSummaryPeriod('LAST_7_DAYS')
    expect(label).toBe('LAST_7_DAYS')
    expect(start).toEqual(startOfUTCDay(addUtcDays(now, -6)))
    expect(end).toEqual(endOfUTCDay(now))
  })

  it('THIS_WEEK starts on Monday UTC through end of today', () => {
    const dayOfWeek = now.getUTCDay()
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    const monday = addUtcDays(now, -daysFromMonday)
    const { start, end, label } = resolvePointSummaryPeriod('THIS_WEEK')
    expect(label).toBe('THIS_WEEK')
    expect(start).toEqual(startOfUTCDay(monday))
    expect(end).toEqual(endOfUTCDay(now))
  })

  it('LAST_WEEK covers previous Mon–Sun UTC week', () => {
    const dayOfWeek = now.getUTCDay()
    const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    const thisMonday = addUtcDays(now, -daysFromMonday)
    const lastMonday = addUtcDays(thisMonday, -7)
    const lastSunday = addUtcDays(thisMonday, -1)
    const { start, end, label } = resolvePointSummaryPeriod('LAST_WEEK')
    expect(label).toBe('LAST_WEEK')
    expect(start).toEqual(startOfUTCDay(lastMonday))
    expect(end).toEqual(endOfUTCDay(lastSunday))
  })

  it('THIS_MONTH starts on first of current UTC month through end of today', () => {
    const firstOfMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    )
    const { start, end, label } = resolvePointSummaryPeriod('THIS_MONTH')
    expect(label).toBe('THIS_MONTH')
    expect(start).toEqual(firstOfMonth)
    expect(end).toEqual(endOfUTCDay(now))
  })

  it('LAST_MONTH covers full previous UTC calendar month', () => {
    const prev = utcPreviousYearMonth(now)
    const { start, endExclusive } = utcMonthBoundsExclusive(prev.year, prev.month)
    const lastDay = addUtcDays(endExclusive, -1)
    const { start: rangeStart, end: rangeEnd, label } = resolvePointSummaryPeriod('LAST_MONTH')
    expect(label).toBe('LAST_MONTH')
    expect(rangeStart).toEqual(start)
    expect(rangeEnd).toEqual(endOfUTCDay(lastDay))
  })
})
