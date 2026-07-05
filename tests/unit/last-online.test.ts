import { describe, it, expect } from 'vitest'
import { formatLastOnline } from '../../src/utils/last-online'

describe('formatLastOnline', () => {
  const now = new Date('2026-06-28T12:00:00.000Z')

  it('returns nulls when lastActiveAt is missing', () => {
    expect(formatLastOnline(null, now)).toEqual({
      lastActiveAt: null,
      lastOnlineSeconds: null,
      lastOnlineLabel: null,
    })
  })

  it('formats seconds', () => {
    const at = new Date(now.getTime() - 45_000)
    const r = formatLastOnline(at, now)
    expect(r.lastOnlineSeconds).toBe(45)
    expect(r.lastOnlineLabel).toBe('45s ago')
  })

  it('formats minutes', () => {
    const at = new Date(now.getTime() - 12 * 60_000)
    const r = formatLastOnline(at, now)
    expect(r.lastOnlineLabel).toBe('12m ago')
  })

  it('formats hours', () => {
    const at = new Date(now.getTime() - 3 * 3600_000)
    const r = formatLastOnline(at, now)
    expect(r.lastOnlineLabel).toBe('3h ago')
  })

  it('returns just now for very recent activity', () => {
    const at = new Date(now.getTime() - 5_000)
    expect(formatLastOnline(at, now).lastOnlineLabel).toBe('just now')
  })
})
