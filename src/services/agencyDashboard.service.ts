import {
  agencyDashboardRepository,
  type EarningsOverview,
  type HostDataSummary,
  type HostCommissionItem,
} from '../repositories/agencyDashboard.repository'
import { resolveDashboardPeriod, type DashboardPeriodQuery } from '../utils/datetime'
import { redisClient, RedisKeys, DASHBOARD_TTL_TODAY, DASHBOARD_TTL_PERIOD } from '../config/redis'
import { cacheRedisService } from './cacheRedis.service'
import { AppError } from '../middlewares/errorHandler'

function ttlForLabel(label: string): number {
  return label === 'TODAY' ? DASHBOARD_TTL_TODAY : DASHBOARD_TTL_PERIOD
}

async function readCache<T>(key: string): Promise<T | null> {
  try {
    const hit = await redisClient.get(key)
    if (hit) return JSON.parse(hit) as T
  } catch {
    /* cold / parse error */
  }
  return null
}

/** Invalidate all dashboard period caches for one agent (post commission / payroll credit). */
export async function bustAgencyDashboardCaches(agencyUserId: string): Promise<void> {
  await Promise.all([
    cacheRedisService.del(RedisKeys.agencyDashboardToday(agencyUserId)),
    cacheRedisService.delByKeyPrefix(`agency:dashboard:earnings:${agencyUserId}`),
    cacheRedisService.delByKeyPrefix(`agency:dashboard:hosts:${agencyUserId}`),
  ])
}

async function writeCache(key: string, ttl: number, value: unknown): Promise<void> {
  try {
    await redisClient.setex(key, ttl, JSON.stringify(value))
  } catch {
    /* non-fatal */
  }
}

export const agencyDashboardService = {
  async getEarningsOverview(
    agencyUserId: string,
    query: DashboardPeriodQuery,
  ): Promise<EarningsOverview & { periodLabel: string }> {
    const { start, end, label } = resolveDashboardPeriod(query)
    const cacheKey = RedisKeys.agencyDashboardEarnings(agencyUserId, label)

    const cached = await readCache<EarningsOverview & { periodLabel: string }>(cacheKey)
    if (cached) return cached

    const result = await agencyDashboardRepository.getEarningsOverview(agencyUserId, start, end)
    const dto = { ...result, periodLabel: label }
    await writeCache(cacheKey, ttlForLabel(label), dto)
    return dto
  },

  async getHostDataSummary(
    agencyUserId: string,
    query: DashboardPeriodQuery,
  ): Promise<HostDataSummary & { periodLabel: string }> {
    const { start, end, label } = resolveDashboardPeriod(query)
    const cacheKey = RedisKeys.agencyDashboardHostSummary(agencyUserId, label)

    const cached = await readCache<HostDataSummary & { periodLabel: string }>(cacheKey)
    if (cached) return cached

    const result = await agencyDashboardRepository.getHostDataSummary(agencyUserId, start, end)
    const dto = { ...result, periodLabel: label }
    await writeCache(cacheKey, ttlForLabel(label), dto)
    return dto
  },

  async getHostCommissionList(
    agencyUserId: string,
    query: DashboardPeriodQuery & { limit?: number; cursor?: number },
  ): Promise<{ items: HostCommissionItem[]; nextCursor: number | null; total: number }> {
    // No Redis cache for the paginated list — too many permutations; served from
    // the read replica.
    const { start, end } = resolveDashboardPeriod(query)
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 50)
    const cursor = Math.max(query.cursor ?? 0, 0)
    return agencyDashboardRepository.getHostCommissionList(agencyUserId, start, end, limit, cursor)
  },

  async getHostDrilldown(agencyUserId: string, hostUserId: string, query: DashboardPeriodQuery) {
    const { start, end } = resolveDashboardPeriod(query)
    const isMember = await agencyDashboardRepository.verifyHostMembership(agencyUserId, hostUserId)
    if (!isMember) {
      throw new AppError(404, 'Host not found in this agency', 'HOST_NOT_IN_AGENCY')
    }
    return agencyDashboardRepository.getHostDrilldown(agencyUserId, hostUserId, start, end)
  },

  async getAgentEarnedToday(agencyUserId: string) {
    const cacheKey = RedisKeys.agencyDashboardToday(agencyUserId)
    const cached =
      await readCache<Awaited<ReturnType<typeof agencyDashboardRepository.getAgentEarnedToday>>>(
        cacheKey,
      )
    if (cached) return cached

    const result = await agencyDashboardRepository.getAgentEarnedToday(agencyUserId)
    await writeCache(cacheKey, DASHBOARD_TTL_TODAY, result)
    return result
  },
}
