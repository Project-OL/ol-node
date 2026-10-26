import { describe, it, expect, vi, beforeEach } from 'vitest'

const queryRawUnsafe = vi.fn()
vi.mock('../../src/config/database', () => ({ prisma: {}, prismaRead: { $queryRawUnsafe: queryRawUnsafe } }))
vi.mock('../../src/config/gcp', () => ({ getBigQueryClient: vi.fn() }))

const { istDay, istDayBounds, computeDay } = await import('../../src/jobs/business-metrics.job')

describe('OBS-04 business metrics', () => {
  beforeEach(() => queryRawUnsafe.mockReset())

  it('IST day boundaries', () => {
    // 2026-10-20 00:10 IST is 2026-10-19 18:40 UTC: "yesterday" in IST is the 19th.
    const now = new Date('2026-10-19T18:40:00Z')
    expect(istDay(now, 0)).toBe('2026-10-20')
    expect(istDay(now, 1)).toBe('2026-10-19')
    const { from, to } = istDayBounds('2026-10-19')
    expect(from.toISOString()).toBe('2026-10-18T18:30:00.000Z')
    expect(to.toISOString()).toBe('2026-10-19T18:30:00.000Z')
  })

  it('maps query results to metrics, counting only the user-side legs', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([
        { t: 'GIFT_SEND', d: 'DEBIT', n: 5n, s: 1500n },
        { t: 'TOPUP', d: 'CREDIT', n: 2n, s: 100000n },
        { t: 'GAME_WAGER_OUT', d: 'DEBIT', n: 7n, s: 700n },
        { t: 'GAME_WAGER_IN', d: 'CREDIT', n: 7n, s: 700n },
      ])
      .mockResolvedValueOnce([{ v: 8n }])
      .mockResolvedValueOnce([{ v: 72n }])
      .mockResolvedValueOnce([{ n: 3n, secs: 390n }])
      .mockResolvedValueOnce([{ n: 86n, hosts: 32n, secs: 148206n }])
      .mockResolvedValueOnce([{ n: 2n, pts: 5000n }])
      .mockResolvedValueOnce([{ n: 1n, pts: 2000n }])
      .mockResolvedValueOnce([{ v: 81 }])
    const rows = await computeDay('2026-10-19')
    const m = Object.fromEntries(rows.map((r) => [r.metric, r.value]))
    expect(rows.every((r) => r.day === '2026-10-19')).toBe(true)
    expect(m['gifts.coins']).toBe(1500)
    expect(m['gifts.count']).toBe(5)
    expect(m['coins.topup']).toBe(100000)
    expect(m['games.wagered']).toBe(700)
    expect(m['games.rounds']).toBe(7)
    expect(m['calls.coins']).toBe(0)
    expect(m['users.new']).toBe(8)
    expect(m['users.active']).toBe(72)
    expect(m['users.active_traffic']).toBe(81)
    expect(m['calls.minutes']).toBe(6.5)
    expect(m['live.hours']).toBe(41.17)
    expect(m['live.hosts']).toBe(32)
    expect(m['withdrawals.paid_points']).toBe(2000)
    expect(new Set(rows.map((r) => r.metric)).size).toBe(rows.length)
  })

  it('leaves users.active_traffic out for days before the traffic collectors', async () => {
    for (let i = 0; i < 7; i++) queryRawUnsafe.mockResolvedValueOnce([])
    queryRawUnsafe.mockResolvedValueOnce([])
    const rows = await computeDay('2026-10-19')
    expect(rows.some((r) => r.metric === 'users.active_traffic')).toBe(false)
  })
})
