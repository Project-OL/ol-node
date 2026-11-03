import { describe, it, expect, vi, beforeEach } from 'vitest'

const listTimeSeries = vi.fn()
vi.mock('../../src/config/gcp', () => ({
  isGcpInfraMonitorConfigured: () => true,
  gcpProjectId: () => 'offoo-prod',
  getMetricServiceClient: async () => ({
    projectPath: (p: string) => `projects/${p}`,
    listTimeSeries: (...args: unknown[]) => listTimeSeries(...args),
  }),
}))
const cache = new Map<string, string>()
vi.mock('../../src/services/cache.service', () => ({
  cacheService: {
    get: async (k: string) => cache.get(k) ?? null,
    set: async (k: string, v: string) => void cache.set(k, v),
  },
}))

const { livekitBandwidthService, __test } = await import('../../src/services/livekit-bandwidth.service')

const series = (dir: string, points: Array<[number, number]>) => ({
  metric: { labels: { direction: dir } },
  points: points.map(([t, v]) => ({ interval: { endTime: { seconds: t } }, value: { doubleValue: v } })),
})

describe('livekitBandwidthService (LIVE-63)', () => {
  beforeEach(() => {
    listTimeSeries.mockReset()
    cache.clear()
  })

  it('sums deltas per direction, converts rates to Mbps and computes % of 32 TB', async () => {
    listTimeSeries.mockImplementation(async (req: { aggregation: { perSeriesAligner: string; alignmentPeriod: { seconds: number } } }) => {
      if (req.aggregation.perSeriesAligner === 'ALIGN_DELTA') {
        // month-to-date / 30 d: 3.2 TB in + 1.6 TB out
        return [[series('incoming', [[1, 3.2e12]]), series('outgoing', [[1, 1.6e12]])]]
      }
      if (req.aggregation.alignmentPeriod.seconds === 600) {
        return [[series('incoming', [[10, 12.5e6]]), series('outgoing', [[10, 2.5e6]])]] // bytes/s
      }
      return [[series('incoming', [[100, 1e6], [200, 50e6]]), series('outgoing', [[100, 1e6], [200, 10e6]])]]
    })

    const dto = await __test.compute(new Date('2026-11-16T00:00:00Z'))
    expect(dto.monthToDate.totalBytes).toBe(4.8e12)
    expect(dto.monthToDate.pctOfQuota).toBe(15)
    expect(dto.monthToDate.from).toBe('2026-11-01T00:00:00.000Z')
    expect(dto.projectedMonthBytes).toBe(9.6e12) // 15 days elapsed of 30
    expect(dto.currentMbps).toEqual({ incoming: 100, outgoing: 20 })
    expect(dto.peakMbps7d).toBe(480)
    expect(dto.hourly7d).toHaveLength(2)
    expect(dto.hourly7d[1]).toMatchObject({ incomingMbps: 400, outgoingMbps: 80 })
  })

  it('returns { error } instead of throwing, and caches successes', async () => {
    listTimeSeries.mockRejectedValueOnce(new Error('PERMISSION_DENIED'))
    expect(await livekitBandwidthService.get()).toEqual({ error: 'PERMISSION_DENIED' })

    listTimeSeries.mockResolvedValue([[]])
    const first = await livekitBandwidthService.get()
    expect('error' in first).toBe(false)
    const calls = listTimeSeries.mock.calls.length
    await livekitBandwidthService.get()
    expect(listTimeSeries.mock.calls.length).toBe(calls)
    await livekitBandwidthService.get(true)
    expect(listTimeSeries.mock.calls.length).toBeGreaterThan(calls)
  })
})
