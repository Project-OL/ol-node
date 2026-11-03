import { getMetricServiceClient, gcpProjectId, isGcpInfraMonitorConfigured } from '../config/gcp'
import { cacheService } from './cache.service'
import { RedisKeys } from '../config/redis'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'livekit-bandwidth' })

/**
 * LIVE-63: video-server (Hostinger LiveKit VPS) transfer against its monthly allowance.
 *
 * Source: `livekit_packet_bytes` (media in + out), scraped from the VPS by the main VM's Ops Agent
 * (OBS-07). It leaves out HLS/TCP/TLS overhead, so Hostinger's own counter runs somewhat higher:
 * the page says so, and the alerts (Cloud Monitoring "LIVE-63 …") use the same series.
 */
export const LIVEKIT_MONTHLY_QUOTA_BYTES = 32e12
const PORT_MBPS = 1000
const CACHE_KEY = RedisKeys.livekitBandwidth()
const CACHE_TTL_SEC = 300
const METRIC_FILTER =
  'metric.type="prometheus.googleapis.com/livekit_packet_bytes/counter" AND resource.type="prometheus_target"'

type Direction = 'incoming' | 'outgoing'
type InOut = { incoming: number; outgoing: number }

export type LiveKitBandwidthDto = {
  source: string
  monthlyQuotaBytes: number
  monthToDate: {
    from: string
    incomingBytes: number
    outgoingBytes: number
    totalBytes: number
    pctOfQuota: number
  }
  rolling30d: {
    incomingBytes: number
    outgoingBytes: number
    totalBytes: number
    pctOfQuota: number
  }
  /** Projection of month-to-date at the current month's average daily rate. */
  projectedMonthBytes: number
  currentMbps: InOut
  peakMbps7d: number
  hourly7d: Array<{ t: string; incomingMbps: number; outgoingMbps: number }>
  thresholds: { warnPct: number; critPct: number; portMbps: number; portAlertMbps: number }
  generatedAt: string
  error?: string
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp
const pct = (bytes: number) => round((bytes / LIVEKIT_MONTHLY_QUOTA_BYTES) * 100, 3)

/** int64 values arrive as number, string or Long depending on the gRPC decoder. */
function pointValue(p: { value?: { doubleValue?: number | null; int64Value?: unknown } | null }) {
  const v = p.value
  if (!v) return 0
  if (v.doubleValue != null) return Number(v.doubleValue)
  return Number(String(v.int64Value ?? 0))
}

/** Sum per direction over [start, end] (one aligned bucket the length of the window). */
async function deltaByDirection(startSec: number, endSec: number): Promise<InOut> {
  const client = await getMetricServiceClient()
  const period = Math.max(60, endSec - startSec)
  const [series] = await client.listTimeSeries({
    name: client.projectPath(gcpProjectId() as string),
    filter: METRIC_FILTER,
    interval: { startTime: { seconds: endSec - period }, endTime: { seconds: endSec } },
    aggregation: {
      alignmentPeriod: { seconds: period },
      perSeriesAligner: 'ALIGN_DELTA',
      crossSeriesReducer: 'REDUCE_SUM',
      groupByFields: ['metric.label.direction'],
    },
  })
  const out: InOut = { incoming: 0, outgoing: 0 }
  for (const s of series) {
    const dir = s.metric?.labels?.direction as Direction | undefined
    if (dir !== 'incoming' && dir !== 'outgoing') continue
    out[dir] += (s.points ?? []).reduce((sum, p) => sum + pointValue(p), 0)
  }
  return out
}

/** Bytes/s per direction, bucketed. Returned oldest first. */
async function rateSeries(startSec: number, endSec: number, periodSec: number) {
  const client = await getMetricServiceClient()
  const [series] = await client.listTimeSeries({
    name: client.projectPath(gcpProjectId() as string),
    filter: METRIC_FILTER,
    interval: { startTime: { seconds: startSec }, endTime: { seconds: endSec } },
    aggregation: {
      alignmentPeriod: { seconds: periodSec },
      perSeriesAligner: 'ALIGN_RATE',
      crossSeriesReducer: 'REDUCE_SUM',
      groupByFields: ['metric.label.direction'],
    },
  })
  const byTime = new Map<number, InOut>()
  for (const s of series) {
    const dir = s.metric?.labels?.direction as Direction | undefined
    if (dir !== 'incoming' && dir !== 'outgoing') continue
    for (const p of s.points ?? []) {
      const t = Number(p.interval?.endTime?.seconds ?? 0)
      const row = byTime.get(t) ?? { incoming: 0, outgoing: 0 }
      row[dir] += pointValue(p)
      byTime.set(t, row)
    }
  }
  return [...byTime.entries()].sort((a, b) => a[0] - b[0])
}

const toMbps = (bytesPerSec: number) => round((bytesPerSec * 8) / 1e6)

async function compute(now = new Date()): Promise<LiveKitBandwidthDto> {
  const nowSec = Math.floor(now.getTime() / 1000)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const monthStartSec = Math.floor(monthStart.getTime() / 1000)
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate()

  const [mtd, r30, current, hourly] = await Promise.all([
    deltaByDirection(monthStartSec, nowSec),
    deltaByDirection(nowSec - 30 * 86400, nowSec),
    rateSeries(nowSec - 600, nowSec, 600),
    rateSeries(nowSec - 7 * 86400, nowSec, 3600),
  ])
  const mtdTotal = mtd.incoming + mtd.outgoing
  const r30Total = r30.incoming + r30.outgoing
  const elapsedDays = Math.max((nowSec - monthStartSec) / 86400, 1 / 24)
  const last = current.at(-1)?.[1] ?? { incoming: 0, outgoing: 0 }
  const hourly7d = hourly.map(([t, v]) => ({
    t: new Date(t * 1000).toISOString(),
    incomingMbps: toMbps(v.incoming),
    outgoingMbps: toMbps(v.outgoing),
  }))

  return {
    source: 'livekit_packet_bytes (media in + out; excludes HLS/TCP/TLS overhead)',
    monthlyQuotaBytes: LIVEKIT_MONTHLY_QUOTA_BYTES,
    monthToDate: {
      from: monthStart.toISOString(),
      incomingBytes: Math.round(mtd.incoming),
      outgoingBytes: Math.round(mtd.outgoing),
      totalBytes: Math.round(mtdTotal),
      pctOfQuota: pct(mtdTotal),
    },
    rolling30d: {
      incomingBytes: Math.round(r30.incoming),
      outgoingBytes: Math.round(r30.outgoing),
      totalBytes: Math.round(r30Total),
      pctOfQuota: pct(r30Total),
    },
    projectedMonthBytes: Math.round((mtdTotal / elapsedDays) * daysInMonth),
    currentMbps: { incoming: toMbps(last.incoming), outgoing: toMbps(last.outgoing) },
    peakMbps7d: hourly7d.reduce((m, h) => Math.max(m, h.incomingMbps + h.outgoingMbps), 0),
    hourly7d,
    thresholds: { warnPct: 60, critPct: 80, portMbps: PORT_MBPS, portAlertMbps: 800 },
    generatedAt: now.toISOString(),
  }
}

export const livekitBandwidthService = {
  /** Cached 5 minutes. Never throws: returns `{ error }` when monitoring isn't reachable. */
  async get(forceRefresh = false): Promise<LiveKitBandwidthDto | { error: string }> {
    if (!isGcpInfraMonitorConfigured()) return { error: 'GCP_PROJECT_ID is not set' }
    if (!forceRefresh) {
      const cached = await cacheService.get(CACHE_KEY).catch(() => null)
      if (cached) {
        try {
          return JSON.parse(cached) as LiveKitBandwidthDto
        } catch {
          /* recompute */
        }
      }
    }
    try {
      const dto = await compute()
      await cacheService.set(CACHE_KEY, JSON.stringify(dto), CACHE_TTL_SEC).catch(() => {})
      return dto
    } catch (err) {
      log.error({ err }, 'LiveKit bandwidth query failed')
      return { error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const __test = { compute }
