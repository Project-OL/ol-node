import { rootLogger } from './rootLogger'

const log = rootLogger.child({ module: 'request-metrics' })

const MAX_SAMPLES_PER_ROUTE = 10_000

type RouteSamples = {
  durations: number[]
  dbQueries: number[]
  redisOps: number[]
}

const samplesByRoute = new Map<string, RouteSamples>()

function routeKey(method: string, route: string | undefined, url: string): string {
  if (route) return `${method} ${route}`
  return `${method} ${url.split('?')[0]}`
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))]!
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

export type RouteMetricSnapshot = {
  count: number
  p50: number
  p95: number
  p99: number
  max: number
  dbQueriesAvg: number
  dbQueriesP95: number
  redisOpsAvg: number
}

export const requestMetrics = {
  record(
    method: string,
    route: string | undefined,
    url: string,
    durationMs: number,
    io?: { dbQueries: number; redisOps: number },
  ): void {
    const key = routeKey(method, route, url)
    let bucket = samplesByRoute.get(key)
    if (!bucket) {
      bucket = { durations: [], dbQueries: [], redisOps: [] }
      samplesByRoute.set(key, bucket)
    }
    if (bucket.durations.length >= MAX_SAMPLES_PER_ROUTE) {
      bucket.durations.shift()
      bucket.dbQueries.shift()
      bucket.redisOps.shift()
    }
    bucket.durations.push(durationMs)
    bucket.dbQueries.push(io?.dbQueries ?? 0)
    bucket.redisOps.push(io?.redisOps ?? 0)
  },

  snapshot(): Record<string, RouteMetricSnapshot> {
    const out: Record<string, RouteMetricSnapshot> = {}
    for (const [key, bucket] of samplesByRoute) {
      const sorted = [...bucket.durations].sort((a, b) => a - b)
      const sortedDb = [...bucket.dbQueries].sort((a, b) => a - b)
      out[key] = {
        count: sorted.length,
        p50: Math.round(percentile(sorted, 50) * 10) / 10,
        p95: Math.round(percentile(sorted, 95) * 10) / 10,
        p99: Math.round(percentile(sorted, 99) * 10) / 10,
        max: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
        dbQueriesAvg: Math.round(avg(bucket.dbQueries) * 10) / 10,
        dbQueriesP95: percentile(sortedDb, 95),
        redisOpsAvg: Math.round(avg(bucket.redisOps) * 10) / 10,
      }
    }
    return out
  },

  logSummary(label = 'request-metrics'): void {
    const snapshot = this.snapshot()
    const routes = Object.keys(snapshot)
    if (routes.length === 0) return
    log.info({ label, routes: snapshot }, 'server request latency percentiles (ms)')
  },

  reset(): void {
    samplesByRoute.clear()
  },
}
