import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/config/redis', () => ({ redisClient: {}, RedisKeys: {} }))
vi.mock('../../src/config/database', () => ({ prisma: {}, prismaRead: {} }))

import { istDayRange, istToday, summarizeDay } from '../../src/services/traffic-admin.service'
import { istDayDate, istHourStart } from '../../src/services/traffic.service'

const at = (hhmm: string) => new Date(`2026-10-26T${hhmm}:00+05:30`).toISOString()

describe('IST day helpers', () => {
  it('maps an IST date to its instant range', () => {
    const { from, to } = istDayRange('2026-10-26')
    expect(from.toISOString()).toBe('2026-10-25T18:30:00.000Z')
    expect(to.getTime() - from.getTime()).toBe(86_400_000)
  })

  it('gives today in IST, not UTC', () => {
    expect(istToday(Date.parse('2026-10-25T19:00:00Z'))).toBe('2026-10-26')
  })

  it('turns hour and day keys into instants and DATE values', () => {
    expect(istHourStart('2026102612').toISOString()).toBe('2026-10-26T06:30:00.000Z')
    expect(istDayDate('20261026').toISOString()).toBe('2026-10-26T00:00:00.000Z')
  })
})

describe('summarizeDay', () => {
  it('returns nulls for a day with no samples', () => {
    expect(summarizeDay([])).toEqual({ coverageMinutes: 0, peak: null, low: null, median: null, quietWindow: null })
  })

  it('finds peak, low (first occurrence), median and the longest contiguous quiet run', () => {
    const points = [
      { t: at('02:00'), online: 1 },
      { t: at('02:01'), online: 0 },
      { t: at('02:02'), online: 1 },
      { t: at('02:03'), online: 10 },
      { t: at('02:04'), online: 2 },
      { t: at('02:05'), online: 2 },
      // 02:06 missing: a gap breaks the quiet run
      { t: at('02:07'), online: 1 },
    ]
    const s = summarizeDay(points)
    expect(s.peak).toEqual({ online: 10, at: at('02:03') })
    expect(s.low).toEqual({ online: 0, at: at('02:01') })
    expect(s.median).toBe(1)
    expect(s.quietWindow).toEqual({ from: at('02:00'), to: at('02:02'), minutes: 3, threshold: 2 })
  })

  it('has no quiet window when nobody was ever online', () => {
    expect(summarizeDay([{ t: at('03:00'), online: 0 }]).quietWindow).toBeNull()
  })
})
