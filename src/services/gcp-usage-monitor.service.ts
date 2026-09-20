import * as os from 'os'
import { execSync } from 'child_process'
import { monitorEventLoopDelay } from 'perf_hooks'

type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>
import { env } from '../config/env'
import { getMetricServiceClient, gcpProjectId, isGcpInfraMonitorConfigured } from '../config/gcp'
import { rootLogger } from '../utils/rootLogger'

const log = rootLogger.child({ module: 'gcp-usage-monitor' })

/**
 * Started once at process boot, never per collection tick — the histogram accumulates
 * continuously so a read reflects the interval since the last read, not just the
 * instant the collector happens to run. Resetting on read (`.reset()`) matches the
 * "utilization since last hourly check" semantics we want for this monitor.
 */
let eventLoopMonitor: EventLoopDelayMonitor | null = null
function getEventLoopMonitor(): EventLoopDelayMonitor {
  if (!eventLoopMonitor) {
    eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 })
    eventLoopMonitor.enable()
  }
  return eventLoopMonitor
}

export type MetricResult = Record<string, number | null>
type FetchError = { error: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function nsToMs(ns: number): number {
  return Math.round((ns / 1e6) * 100) / 100
}

/**
 * VM's own CPU/memory/disk/event-loop-lag, collected in-process rather than via Cloud
 * Monitoring — the Ops Agent isn't installed on the box, so Cloud Monitoring only has
 * hypervisor-level CPU/network/disk-I/O for this instance, no guest memory/disk-used.
 * Since this collector runs inside the very process being measured, reading `os`/
 * `perf_hooks` directly is both simpler and more accurate than adding an agent.
 */
export function collectVmMetrics(): MetricResult | FetchError {
  try {
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const memUsedPct = ((totalMem - freeMem) / totalMem) * 100
    const cpuCount = os.cpus().length || 1
    const load1 = os.loadavg()[0]
    // Normalized against core count so this reads like a 0-100% utilization figure,
    // consistent with the Cloud SQL/Redis collectors below.
    const cpuPct = Math.min(100, (load1 / cpuCount) * 100)

    let diskUsedPct: number | null = null
    try {
      const df = execSync('df -kP /', { encoding: 'utf8' })
      const line = df.trim().split('\n')[1]
      const parts = line?.trim().split(/\s+/)
      const usedPct = parts?.[4]?.replace('%', '')
      diskUsedPct = usedPct ? Number(usedPct) : null
    } catch (err) {
      // Not fatal — e.g. running locally on Windows where `df` doesn't exist.
      log.warn({ err }, 'VM disk usage check failed (non-Linux host or df unavailable)')
    }

    const monitor = getEventLoopMonitor()
    const eventLoopLagMs = nsToMs(monitor.mean || 0)
    const eventLoopLagP99Ms = nsToMs(monitor.percentile(99) || 0)
    monitor.reset()

    return {
      cpuPct: Math.round(cpuPct * 100) / 100,
      memPct: Math.round(memUsedPct * 100) / 100,
      diskPct: diskUsedPct,
      eventLoopLagMs: Number.isFinite(eventLoopLagMs) ? eventLoopLagMs : null,
      eventLoopLagP99Ms: Number.isFinite(eventLoopLagP99Ms) ? eventLoopLagP99Ms : null,
    }
  } catch (err) {
    log.error({ err }, 'VM metrics collection failed')
    return { error: errorMessage(err) }
  }
}

async function queryLatestMean(filter: string): Promise<number | null> {
  const client = await getMetricServiceClient()
  const nowSeconds = Math.floor(Date.now() / 1000)
  const [timeSeries] = await client.listTimeSeries({
    name: client.projectPath(gcpProjectId() as string),
    filter,
    interval: {
      startTime: { seconds: nowSeconds - 3600 },
      endTime: { seconds: nowSeconds },
    },
    aggregation: {
      alignmentPeriod: { seconds: 3600 },
      perSeriesAligner: 'ALIGN_MEAN',
    },
  })
  const toNumber = (v: number | string | { toNumber?: () => number } | null | undefined) => {
    if (v === null || v === undefined) return null
    if (typeof v === 'object') return typeof v.toNumber === 'function' ? v.toNumber() : Number(v)
    return Number(v)
  }
  const values = timeSeries
    .flatMap((ts) => ts.points ?? [])
    .map((p) => toNumber(p.value?.doubleValue ?? p.value?.int64Value))
    .filter((v): v is number => v !== null && Number.isFinite(v))
  if (values.length === 0) return null
  // Multiple series (e.g. Redis primary+replica nodes) — take the max as the more
  // conservative signal for flagging.
  return Math.max(...values)
}

/** Cloud SQL: CPU/memory/disk utilization (0-1, converted to %) + current connection count. */
export async function collectCloudSqlMetrics(instanceId: string): Promise<MetricResult | FetchError> {
  if (!isGcpInfraMonitorConfigured()) return { error: 'GCP_PROJECT_ID not configured' }
  const projectId = gcpProjectId() as string
  const databaseId = `${projectId}:${instanceId}`
  try {
    const [cpuRatio, memRatio, diskRatio, connections] = await Promise.all([
      queryLatestMean(
        `metric.type="cloudsql.googleapis.com/database/cpu/utilization" AND resource.labels.database_id="${databaseId}"`,
      ),
      queryLatestMean(
        `metric.type="cloudsql.googleapis.com/database/memory/utilization" AND resource.labels.database_id="${databaseId}"`,
      ),
      queryLatestMean(
        `metric.type="cloudsql.googleapis.com/database/disk/utilization" AND resource.labels.database_id="${databaseId}"`,
      ),
      queryLatestMean(
        `metric.type="cloudsql.googleapis.com/database/postgresql/num_backends" AND resource.labels.database_id="${databaseId}"`,
      ),
    ])
    return {
      cpuPct: cpuRatio !== null ? Math.round(cpuRatio * 10000) / 100 : null,
      memPct: memRatio !== null ? Math.round(memRatio * 10000) / 100 : null,
      diskPct: diskRatio !== null ? Math.round(diskRatio * 10000) / 100 : null,
      connections: connections !== null ? Math.round(connections) : null,
    }
  } catch (err) {
    log.error({ err, instanceId }, 'Cloud SQL metrics fetch failed')
    return { error: errorMessage(err) }
  }
}

/** Memorystore Redis: memory usage ratio (0-1, converted to %) + connected clients. */
export async function collectRedisMetrics(
  instanceName: string,
  region: string,
): Promise<MetricResult | FetchError> {
  if (!isGcpInfraMonitorConfigured()) return { error: 'GCP_PROJECT_ID not configured' }
  const projectId = gcpProjectId() as string
  // Memorystore's `instance_id` resource label is the full path, not the short name —
  // confirmed by querying the Monitoring API directly (the short name alone returns
  // zero time series).
  const resourcePath = `projects/${projectId}/locations/${region}/instances/${instanceName}`
  try {
    const [memRatio, clientsConnected] = await Promise.all([
      queryLatestMean(
        `metric.type="redis.googleapis.com/stats/memory/usage_ratio" AND resource.type="redis_instance" AND resource.labels.instance_id="${resourcePath}"`,
      ),
      queryLatestMean(
        `metric.type="redis.googleapis.com/clients/connected" AND resource.type="redis_instance" AND resource.labels.instance_id="${resourcePath}"`,
      ),
    ])
    return {
      memPct: memRatio !== null ? Math.round(memRatio * 10000) / 100 : null,
      connections: clientsConnected !== null ? Math.round(clientsConnected) : null,
    }
  } catch (err) {
    log.error({ err, instanceName }, 'Redis metrics fetch failed')
    return { error: errorMessage(err) }
  }
}

export type ThresholdConfig = {
  cpuWarn?: number
  cpuCrit?: number
  memWarn?: number
  memCrit?: number
  diskWarn?: number
  diskCrit?: number
  connectionsWarn?: number
  connectionsCrit?: number
  eventLoopLagWarnMs?: number
  eventLoopLagCritMs?: number
}

export type FlagCandidate = {
  metric: string
  value: number
  threshold: number
  severity: 'WARNING' | 'CRITICAL'
  message: string
}

const METRIC_LABELS: Record<string, string> = {
  cpuPct: 'CPU utilization',
  memPct: 'Memory utilization',
  diskPct: 'Disk utilization',
  connections: 'Connection count',
  eventLoopLagMs: 'Event-loop lag (mean)',
}

function evalOne(
  metric: string,
  value: number | null | undefined,
  warn: number | undefined,
  crit: number | undefined,
  unit: string,
): FlagCandidate | null {
  if (value === null || value === undefined) return null
  if (crit !== undefined && value >= crit) {
    return {
      metric,
      value,
      threshold: crit,
      severity: 'CRITICAL',
      message: `${METRIC_LABELS[metric] ?? metric} is ${value}${unit}, at or above the critical threshold (${crit}${unit})`,
    }
  }
  if (warn !== undefined && value >= warn) {
    return {
      metric,
      value,
      threshold: warn,
      severity: 'WARNING',
      message: `${METRIC_LABELS[metric] ?? metric} is ${value}${unit}, at or above the warning threshold (${warn}${unit})`,
    }
  }
  return null
}

/** Evaluate one resource's collected metrics against its configured thresholds. */
export function evaluateThresholds(
  metrics: MetricResult | FetchError,
  thresholds: ThresholdConfig,
): FlagCandidate[] {
  if ('error' in metrics) return []
  const candidates: FlagCandidate[] = []
  const cpu = evalOne('cpuPct', metrics.cpuPct, thresholds.cpuWarn, thresholds.cpuCrit, '%')
  const mem = evalOne('memPct', metrics.memPct, thresholds.memWarn, thresholds.memCrit, '%')
  const disk = evalOne('diskPct', metrics.diskPct, thresholds.diskWarn, thresholds.diskCrit, '%')
  const conn = evalOne(
    'connections',
    metrics.connections,
    thresholds.connectionsWarn,
    thresholds.connectionsCrit,
    '',
  )
  const lag = evalOne(
    'eventLoopLagMs',
    metrics.eventLoopLagMs,
    thresholds.eventLoopLagWarnMs,
    thresholds.eventLoopLagCritMs,
    'ms',
  )
  for (const c of [cpu, mem, disk, conn, lag]) if (c) candidates.push(c)
  return candidates
}

export const gcpUsageMonitorService = {
  collectVmMetrics,
  collectCloudSqlMetrics,
  collectRedisMetrics,
  evaluateThresholds,
  isConfigured: isGcpInfraMonitorConfigured,
  renotifyHours: () => env.GCP_INFRA_ALERT_RENOTIFY_HOURS,
}
