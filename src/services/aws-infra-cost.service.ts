import { DescribeInstancesCommand, EC2Client } from '@aws-sdk/client-ec2'
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds'
import { DescribeCacheClustersCommand, ElastiCacheClient } from '@aws-sdk/client-elasticache'
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer'
import { env } from '../config/env'
import {
  INFRA_COST_BY_SERVICE_TTL,
  INFRA_COST_INVENTORY_TTL,
  RedisKeys,
  redisClient,
} from '../config/redis'
import { rootLogger } from '../utils/rootLogger'
import { utcMonthRange } from '../utils/utc-month-range'

const log = rootLogger.child({ module: 'aws-infra-cost' })

function awsCredentials() {
  return env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
    : undefined
}

const ec2Client = new EC2Client({ region: env.AWS_REGION, credentials: awsCredentials() })
const rdsClient = new RDSClient({ region: env.AWS_REGION, credentials: awsCredentials() })
const elastiCacheClient = new ElastiCacheClient({
  region: env.AWS_REGION,
  credentials: awsCredentials(),
})
// Cost Explorer is a single global API served only from us-east-1, regardless of AWS_REGION.
const costExplorerClient = new CostExplorerClient({
  region: 'us-east-1',
  credentials: awsCredentials(),
})

export type Ec2InstanceSummary = {
  instanceId: string | null
  type: string | null
  az: string | null
  name: string | null
  launchTime: string | null
  privateIp: string | null
}

export type RdsInstanceSummary = {
  id: string | null
  class: string | null
  engine: string | null
  multiAz: boolean
  status: string | null
  storageGb: number | null
}

export type ElastiCacheClusterSummary = {
  id: string | null
  nodeType: string | null
  engine: string | null
  numNodes: number | null
  status: string | null
}

type FetchError = { error: string }

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function fetchEc2Instances(): Promise<Ec2InstanceSummary[]> {
  const res = await ec2Client.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: 'instance-state-name', Values: ['running'] }],
    }),
  )
  const instances = (res.Reservations ?? []).flatMap((r) => r.Instances ?? [])
  return instances.map((i) => ({
    instanceId: i.InstanceId ?? null,
    type: i.InstanceType ?? null,
    az: i.Placement?.AvailabilityZone ?? null,
    name: i.Tags?.find((t) => t.Key === 'Name')?.Value ?? null,
    launchTime: i.LaunchTime?.toISOString() ?? null,
    privateIp: i.PrivateIpAddress ?? null,
  }))
}

async function fetchRdsInstances(): Promise<RdsInstanceSummary[]> {
  const res = await rdsClient.send(new DescribeDBInstancesCommand({}))
  return (res.DBInstances ?? []).map((d) => ({
    id: d.DBInstanceIdentifier ?? null,
    class: d.DBInstanceClass ?? null,
    engine: d.Engine ?? null,
    multiAz: d.MultiAZ ?? false,
    status: d.DBInstanceStatus ?? null,
    storageGb: d.AllocatedStorage ?? null,
  }))
}

async function fetchElastiCacheClusters(): Promise<ElastiCacheClusterSummary[]> {
  const res = await elastiCacheClient.send(new DescribeCacheClustersCommand({}))
  return (res.CacheClusters ?? []).map((c) => ({
    id: c.CacheClusterId ?? null,
    nodeType: c.CacheNodeType ?? null,
    engine: c.Engine ?? null,
    numNodes: c.NumCacheNodes ?? null,
    status: c.CacheClusterStatus ?? null,
  }))
}

export type CostByServiceRow = { service: string; amount: number; unit: string }

async function fetchCostByService(
  from: Date,
  to: Date,
): Promise<{ total: number; currency: string; byService: CostByServiceRow[] }> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  const res = await costExplorerClient.send(
    new GetCostAndUsageCommand({
      TimePeriod: { Start: fmt(from), End: fmt(to) },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }),
  )
  const groups = res.ResultsByTime?.[0]?.Groups ?? []
  const byService = groups
    .map((g) => ({
      service: g.Keys?.[0] ?? 'Unknown',
      amount: Number(g.Metrics?.UnblendedCost?.Amount ?? 0),
      unit: g.Metrics?.UnblendedCost?.Unit ?? 'USD',
    }))
    .filter((s) => s.amount > 0)
    .sort((a, b) => b.amount - a.amount)
  const total = byService.reduce((sum, s) => sum + s.amount, 0)
  return { total, currency: byService[0]?.unit ?? 'USD', byService }
}

export const awsInfraCostService = {
  /**
   * Running EC2/RDS/ElastiCache inventory. Cached (`INFRA_COST_INVENTORY_TTL`) since this
   * is a live AWS call on every hit otherwise. Each section fails independently — a
   * missing IAM permission for one service doesn't take down the others.
   */
  async getInventory(opts: { forceRefresh?: boolean } = {}) {
    const key = RedisKeys.infraCostInventory()
    if (!opts.forceRefresh) {
      try {
        const hit = await redisClient.get(key)
        if (hit) return JSON.parse(hit) as Awaited<ReturnType<typeof buildInventory>>
      } catch {
        /* miss */
      }
    }
    const result = await buildInventory()
    try {
      await redisClient.setex(key, INFRA_COST_INVENTORY_TTL, JSON.stringify(result))
    } catch {
      /* ignore */
    }
    return result
  },

  /**
   * Cost Explorer spend by service for a UTC calendar month. Cached
   * (`INFRA_COST_BY_SERVICE_TTL`) — GetCostAndUsage is a billed API call, and Cost
   * Explorer data itself lags ~24h, so there's no upside to fetching more often even for
   * the current, still-forming month.
   */
  async getCostByService(params: { year?: number; month?: number; forceRefresh?: boolean }) {
    const { year, month, from, to } = utcMonthRange(params.year, params.month)
    const key = RedisKeys.infraCostByService(year, month)
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
      await redisClient.setex(key, INFRA_COST_BY_SERVICE_TTL, JSON.stringify(result))
    } catch {
      /* ignore */
    }
    return result
  },
}

async function buildInventory() {
  const [ec2, rds, elastiCache] = await Promise.all([
    fetchEc2Instances().catch((err): FetchError => {
      log.error({ err }, 'EC2 inventory fetch failed')
      return { error: errorMessage(err) }
    }),
    fetchRdsInstances().catch((err): FetchError => {
      log.error({ err }, 'RDS inventory fetch failed')
      return { error: errorMessage(err) }
    }),
    fetchElastiCacheClusters().catch((err): FetchError => {
      log.error({ err }, 'ElastiCache inventory fetch failed')
      return { error: errorMessage(err) }
    }),
  ])
  return {
    fetchedAt: new Date().toISOString(),
    region: env.AWS_REGION,
    ec2InstancesRunning: ec2,
    rdsInstances: rds,
    elastiCacheClusters: elastiCache,
  }
}

async function buildCostByService(year: number, month: number, from: Date, to: Date) {
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
    log.error({ err }, 'Cost Explorer fetch failed')
    return {
      fetchedAt: new Date().toISOString(),
      year,
      month,
      from: from.toISOString(),
      to: to.toISOString(),
      error: `Cost Explorer call failed: ${errorMessage(err)}. If Cost Explorer has never been enabled on this account, turn it on once in the Billing console (it has no enable API) and retry after ~24h.`,
    }
  }
}
