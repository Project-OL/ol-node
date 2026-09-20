import { env } from '../config/env'
import { getBigQueryClient, isGcpInfraMonitorConfigured } from '../config/gcp'
import { GCP_COST_BY_SERVICE_TTL, RedisKeys, redisClient } from '../config/redis'
import { rootLogger } from '../utils/rootLogger'
import { utcMonthRange } from '../utils/utc-month-range'

const log = rootLogger.child({ module: 'gcp-billing-cost' })

export type CostByServiceRow = { service: string; amount: number; unit: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let cachedTableRef: string | null = null

/**
 * The GCP Billing Export table name has a billing-account-derived suffix
 * (`gcp_billing_export_v1_XXXXXX_XXXXXX_XXXXXX`) that isn't knowable in advance —
 * discover it once by listing the configured dataset's tables, then cache it for the
 * process lifetime.
 */
async function resolveBillingTableRef(): Promise<string> {
  if (cachedTableRef) return cachedTableRef
  if (!env.GCP_BILLING_BQ_DATASET) {
    throw new Error('GCP_BILLING_BQ_DATASET is not set')
  }
  const bigquery = getBigQueryClient()
  const [tables] = await bigquery.dataset(env.GCP_BILLING_BQ_DATASET).getTables()
  const table = tables.find((t) => t.id?.startsWith('gcp_billing_export_v1_'))
  if (!table) {
    throw new Error(
      `No gcp_billing_export_v1_* table found in dataset "${env.GCP_BILLING_BQ_DATASET}" — has Billing Export to BigQuery been enabled yet? Export tables can take up to ~24h to appear after enabling.`,
    )
  }
  cachedTableRef = `\`${bigquery.projectId}.${env.GCP_BILLING_BQ_DATASET}.${table.id}\``
  return cachedTableRef
}

async function fetchCostByService(
  from: Date,
  to: Date,
): Promise<{ total: number; currency: string; byService: CostByServiceRow[] }> {
  const bigquery = getBigQueryClient()
  const tableRef = await resolveBillingTableRef()
  const query = `
    SELECT
      service.description AS service,
      SUM(cost) AS amount,
      currency
    FROM ${tableRef}
    WHERE usage_start_time >= @from AND usage_start_time < @to
    GROUP BY service, currency
    HAVING SUM(cost) > 0
    ORDER BY amount DESC
  `
  const [rows] = await bigquery.query({
    query,
    params: { from: from.toISOString(), to: to.toISOString() },
  })
  const byService: CostByServiceRow[] = rows.map((r: { service: string; amount: number; currency: string }) => ({
    service: r.service ?? 'Unknown',
    amount: Number(r.amount ?? 0),
    unit: r.currency ?? 'USD',
  }))
  const total = byService.reduce((sum, s) => sum + s.amount, 0)
  return { total, currency: byService[0]?.unit ?? 'USD', byService }
}

async function buildCostByService(year: number, month: number, from: Date, to: Date) {
  if (!isGcpInfraMonitorConfigured() || !env.GCP_BILLING_BQ_DATASET) {
    return {
      fetchedAt: new Date().toISOString(),
      year,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      error:
        'GCP billing export not configured yet (GCP_PROJECT_ID / GCP_BILLING_BQ_DATASET). Enable Billing Export to BigQuery in the GCP Console — data appears ~24h after enabling.',
    }
  }
  try {
    const cost = await fetchCostByService(from, to)
    return {
      fetchedAt: new Date().toISOString(),
      year,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      ...cost,
    }
  } catch (err) {
    log.error({ err }, 'GCP billing export query failed')
    return {
      fetchedAt: new Date().toISOString(),
      year,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      error: `Billing export query failed: ${errorMessage(err)}. If the export was enabled recently, allow up to ~24h for data to appear.`,
    }
  }
}

export const gcpBillingCostService = {
  /**
   * GCP Billing Export (BigQuery) spend by service for a UTC calendar month. Cached
   * (`GCP_COST_BY_SERVICE_TTL`) — same rationale as the AWS Cost Explorer side: this is
   * a billed BigQuery query and the export itself lags, so no benefit to a shorter TTL.
   */
  async getCostByService(params: { year?: number; month?: number; forceRefresh?: boolean }) {
    const { year, month, from, to } = utcMonthRange(params.year, params.month)
    const key = RedisKeys.gcpCostByService(year, month)
    if (!params.forceRefresh) {
      try {
        const hit = await redisClient.get(key)
        if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof buildCostByService>>
      } catch {
        /* miss */
      }
    }
    const result = await buildCostByService(year, month, from, to)
    try {
      await redisClient.setex(key, GCP_COST_BY_SERVICE_TTL, JSON.stringify(result))
    } catch {
      /* ignore */
    }
    return result
  },
}
