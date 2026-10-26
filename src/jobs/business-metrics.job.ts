import { prismaRead } from '../config/database'
import { env } from '../config/env'
import { getBigQueryClient } from '../config/gcp'
import { rootLogger } from '../utils/rootLogger'

/**
 * OBS-04: daily business metrics, one row per (IST day, metric), in BigQuery
 * (`<BUSINESS_METRICS_BQ_DATASET>.business_daily_metrics`). Off unless that env var and
 * GCP_PROJECT_ID are set.
 *
 * Each run recomputes the last 2 IST days (late writes land in the right day) and replaces their
 * rows, so reruns are idempotent. When the table is empty it backfills BACKFILL_DAYS first.
 * Reads go to the read replica when configured; every query is bounded by one day (all < 250 ms on
 * prod 2026-10-20, coin ledger ~0.7M rows). Double-entry types (games, diamonds) count only the
 * user-side leg, so nothing is counted twice.
 */
const log = rootLogger.child({ module: 'business-metrics-job' })
const TABLE = 'business_daily_metrics'
const BACKFILL_DAYS = 60
const IST_OFFSET_MS = 5.5 * 3600 * 1000

type Row = { day: string; metric: string; value: number }

/** IST calendar day `YYYY-MM-DD` that is `daysAgo` days before the IST day containing `now`. */
export function istDay(now: Date, daysAgo: number): string {
  return new Date(now.getTime() + IST_OFFSET_MS - daysAgo * 86_400_000).toISOString().slice(0, 10)
}

export function istDayBounds(day: string): { from: Date; to: Date } {
  const from = new Date(`${day}T00:00:00+05:30`)
  return { from, to: new Date(from.getTime() + 86_400_000) }
}

// [metric name, coin tx type, direction, 'sum' | 'count']
const COIN_METRICS: [string, string, 'CREDIT' | 'DEBIT', 'sum' | 'count'][] = [
  ['coins.topup', 'TOPUP', 'CREDIT', 'sum'],
  ['coins.topup_count', 'TOPUP', 'CREDIT', 'count'],
  ['coins.trading_topup', 'TRADING_TOPUP', 'CREDIT', 'sum'],
  ['gifts.coins', 'GIFT_SEND', 'DEBIT', 'sum'],
  ['gifts.count', 'GIFT_SEND', 'DEBIT', 'count'],
  ['gifts.refund_coins', 'GIFT_REFUND', 'CREDIT', 'sum'],
  ['calls.coins', 'VIDEO_CALL', 'DEBIT', 'sum'],
  ['global_message.coins', 'GLOBAL_MESSAGE', 'DEBIT', 'sum'],
  ['vip.coins', 'VIP_PURCHASE', 'DEBIT', 'sum'],
  ['vip_membership.coins', 'VIP_MEMBERSHIP_PURCHASE', 'DEBIT', 'sum'],
  ['games.wagered', 'GAME_WAGER_OUT', 'DEBIT', 'sum'],
  ['games.rounds', 'GAME_WAGER_OUT', 'DEBIT', 'count'],
  ['games.paid_out', 'GAME_RESULT_IN', 'CREDIT', 'sum'],
]

type Agg = { t: string; d: string; n: bigint; s: bigint }

export async function computeDay(day: string): Promise<Row[]> {
  const { from, to } = istDayBounds(day)
  const db = prismaRead
  const [coin, usersNew, usersActive, calls, live, wReq, wPaid] = await Promise.all([
    db.$queryRawUnsafe<Agg[]>(
      `select tx_type::text t, direction::text d, count(*)::bigint n, coalesce(sum(amount),0)::bigint s
         from coin_ledger_entries where created_at >= $1 and created_at < $2 group by 1, 2`,
      from,
      to,
    ),
    db.$queryRawUnsafe<{ v: bigint }[]>(
      `select count(*)::bigint v from users where created_at >= $1 and created_at < $2`,
      from,
      to,
    ),
    db.$queryRawUnsafe<{ v: bigint }[]>(
      `select count(distinct user_id)::bigint v from sessions where last_active_at >= $1 and last_active_at < $2`,
      from,
      to,
    ),
    db.$queryRawUnsafe<{ n: bigint; secs: bigint }[]>(
      `select count(*)::bigint n, coalesce(sum(extract(epoch from (ended_at - started_at))), 0)::bigint secs
         from video_call_sessions where started_at >= $1 and started_at < $2`,
      from,
      to,
    ),
    db.$queryRawUnsafe<{ n: bigint; hosts: bigint; secs: bigint }[]>(
      `select count(*)::bigint n, count(distinct user_id)::bigint hosts, coalesce(sum(effective_duration_seconds), 0)::bigint secs
         from live_streams where started_at >= $1 and started_at < $2`,
      from,
      to,
    ),
    db.$queryRawUnsafe<{ n: bigint; pts: bigint }[]>(
      `select count(*)::bigint n, coalesce(sum(amount_points), 0)::bigint pts from withdrawals where requested_at >= $1 and requested_at < $2`,
      from,
      to,
    ),
    db.$queryRawUnsafe<{ n: bigint; pts: bigint }[]>(
      `select count(*)::bigint n, coalesce(sum(amount_points), 0)::bigint pts from withdrawals
         where status = 'PAID' and processed_at >= $1 and processed_at < $2`,
      from,
      to,
    ),
  ])

  const rows: Row[] = []
  const add = (metric: string, v: bigint | number | undefined) =>
    rows.push({ day, metric, value: Number(v ?? 0) })
  for (const [metric, type, dir, kind] of COIN_METRICS) {
    const hit = coin.find((c) => c.t === type && c.d === dir)
    add(metric, hit ? (kind === 'sum' ? hit.s : hit.n) : 0)
  }
  add('users.new', usersNew[0]?.v)
  add('users.active', usersActive[0]?.v)
  // TRF-04: distinct users from request/socket HyperLogLogs. Unlike users.active it is not
  // shrunk by later activity overwriting sessions.last_active_at. Absent before 2026-10-26.
  const trafficActive = await db.$queryRawUnsafe<{ v: number }[]>(
    `select users::int v from traffic_daily where day = $1::date and section = '*'`,
    day,
  )
  if (trafficActive[0]) add('users.active_traffic', trafficActive[0].v)
  add('calls.count', calls[0]?.n)
  add('calls.minutes', Math.round(Number(calls[0]?.secs ?? 0) / 6) / 10)
  add('live.streams', live[0]?.n)
  add('live.hosts', live[0]?.hosts)
  add('live.hours', Math.round(Number(live[0]?.secs ?? 0) / 36) / 100)
  add('withdrawals.requested_count', wReq[0]?.n)
  add('withdrawals.requested_points', wReq[0]?.pts)
  add('withdrawals.paid_count', wPaid[0]?.n)
  add('withdrawals.paid_points', wPaid[0]?.pts)
  return rows
}

async function ensureTable(dataset: string) {
  const bq = getBigQueryClient()
  const table = bq.dataset(dataset).table(TABLE)
  const [exists] = await table.exists()
  if (!exists) {
    await bq.dataset(dataset).createTable(TABLE, {
      schema: [
        { name: 'day', type: 'DATE', mode: 'REQUIRED' },
        { name: 'metric', type: 'STRING', mode: 'REQUIRED' },
        { name: 'value', type: 'FLOAT64', mode: 'REQUIRED' },
        { name: 'computed_at', type: 'TIMESTAMP', mode: 'REQUIRED' },
      ],
      timePartitioning: { type: 'MONTH', field: 'day' },
      description:
        'OBS-04 daily business metrics (IST days), written by ol-node-rest business-metrics job',
    })
    return true
  }
  return false
}

async function writeDays(dataset: string, rows: Row[]) {
  if (!rows.length) return
  const bq = getBigQueryClient()
  const ref = `\`${bq.projectId}.${dataset}.${TABLE}\``
  const days = [...new Set(rows.map((r) => r.day))]
  // DML (not streaming inserts) so the DELETE of a re-run is never blocked by a streaming buffer.
  await bq.query({
    query: `BEGIN TRANSACTION;
            DELETE FROM ${ref} WHERE day IN (SELECT DATE(d) FROM UNNEST(@days) d);
            INSERT INTO ${ref} (day, metric, value, computed_at)
              SELECT DATE(r.day), r.metric, r.value, CURRENT_TIMESTAMP() FROM UNNEST(@rows) r;
            COMMIT TRANSACTION;`,
    params: { days, rows },
    types: { days: ['STRING'], rows: [{ day: 'STRING', metric: 'STRING', value: 'FLOAT64' }] },
  })
}

export async function runBusinessMetricsJob(
  now = new Date(),
): Promise<{ days: number; rows: number }> {
  const dataset = env.BUSINESS_METRICS_BQ_DATASET?.trim()
  if (!dataset || !env.GCP_PROJECT_ID) return { days: 0, rows: 0 }
  const created = await ensureTable(dataset)
  let backfill = created
  if (!created) {
    const bq = getBigQueryClient()
    const [r] = await bq.query({
      query: `SELECT COUNT(*) n FROM \`${bq.projectId}.${dataset}.${TABLE}\``,
    })
    backfill = Number(r[0]?.n ?? 0) === 0
  }
  const span = backfill ? BACKFILL_DAYS : 2
  let total = 0
  // Oldest first, a week per write, so a backfill never builds one huge statement.
  for (let start = span; start >= 1; start -= 7) {
    const batch: Row[] = []
    for (let d = start; d > Math.max(0, start - 7); d--)
      batch.push(...(await computeDay(istDay(now, d))))
    await writeDays(dataset, batch)
    total += batch.length
  }
  log.info({ dataset, days: span, rows: total, backfill }, 'business metrics written')
  return { days: span, rows: total }
}
