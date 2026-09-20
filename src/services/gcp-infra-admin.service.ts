import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import type { GcpResourceConfigUpdate } from '../models/gcp-infra-admin.schemas'
import type { ThresholdConfig } from './gcp-usage-monitor.service'

const RANGE_TO_MS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

/**
 * "2x headroom" is informational, not a separate alerting mechanism — a resource is
 * flagged OK as long as its latest CPU/memory/disk sit below half the resource's own
 * warning threshold, since doubling current usage would then still land under warn.
 * Falls back to "unknown" when there's no snapshot yet or no threshold configured for
 * a given metric.
 */
function computeHeadroomFor2x(
  metrics: Record<string, number | null> | null,
  thresholds: ThresholdConfig,
): 'OK' | 'AT_RISK' | 'UNKNOWN' {
  if (!metrics) return 'UNKNOWN'
  const checks: Array<[number | null | undefined, number | undefined]> = [
    [metrics.cpuPct, thresholds.cpuWarn],
    [metrics.memPct, thresholds.memWarn],
    [metrics.diskPct, thresholds.diskWarn],
  ]
  const usable = checks.filter(([v, warn]) => v !== null && v !== undefined && warn !== undefined)
  if (usable.length === 0) return 'UNKNOWN'
  const atRisk = usable.some(([v, warn]) => (v as number) * 2 >= (warn as number))
  return atRisk ? 'AT_RISK' : 'OK'
}

export const gcpInfraAdminService = {
  async listResourcesWithLatestUsage() {
    const resources = await prisma.gcpResourceConfig.findMany({
      where: { isActive: true },
      orderBy: { displayName: 'asc' },
    })
    return Promise.all(
      resources.map(async (resource) => {
        const latest = await prisma.gcpUsageSnapshot.findFirst({
          where: { resourceKey: resource.resourceKey },
          orderBy: { capturedAt: 'desc' },
        })
        const thresholds = (resource.thresholdsJson as ThresholdConfig | null) ?? {}
        const metrics = (latest?.metricsJson as Record<string, number | null> | null) ?? null
        return {
          resourceKey: resource.resourceKey,
          resourceType: resource.resourceType,
          displayName: resource.displayName,
          currentTier: resource.currentTier,
          currentSpecs: resource.currentSpecsJson,
          targetTierFor2x: resource.targetTierFor2x,
          suggestedNextTier: resource.suggestedNextTier,
          estimatedMonthlyCostUsd: resource.estimatedMonthlyCostUsd
            ? Number(resource.estimatedMonthlyCostUsd)
            : null,
          thresholds,
          runbookMarkdown: resource.runbookMarkdown,
          latestUsage: metrics,
          latestCapturedAt: latest?.capturedAt?.toISOString() ?? null,
          headroomFor2x: computeHeadroomFor2x(metrics, thresholds),
        }
      }),
    )
  },

  async getResourceHistory(resourceKey: string, range: '24h' | '7d' | '30d') {
    const since = new Date(Date.now() - RANGE_TO_MS[range])
    const snapshots = await prisma.gcpUsageSnapshot.findMany({
      where: { resourceKey, capturedAt: { gte: since } },
      orderBy: { capturedAt: 'asc' },
    })
    return snapshots.map((s) => ({
      capturedAt: s.capturedAt.toISOString(),
      metrics: s.metricsJson,
    }))
  },

  async listFlags(status?: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED') {
    const flags = await prisma.gcpInfraFlag.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { severity: 'asc' }, { firstDetectedAt: 'desc' }],
      take: 500,
    })
    return flags.map((f) => ({
      id: f.id,
      resourceKey: f.resourceKey,
      metric: f.metric,
      value: Number(f.value),
      threshold: Number(f.threshold),
      severity: f.severity,
      status: f.status,
      message: f.message,
      firstDetectedAt: f.firstDetectedAt.toISOString(),
      lastNotifiedAt: f.lastNotifiedAt?.toISOString() ?? null,
      resolvedAt: f.resolvedAt?.toISOString() ?? null,
      resolvedByAdminId: f.resolvedByAdminId,
    }))
  },

  async resolveFlag(flagId: string, adminId: string) {
    return prisma.gcpInfraFlag.update({
      where: { id: flagId },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByAdminId: adminId },
    })
  },

  async getResourceConfig(resourceKey: string) {
    return prisma.gcpResourceConfig.findUnique({ where: { resourceKey } })
  },

  async updateResourceConfig(resourceKey: string, update: GcpResourceConfigUpdate) {
    const existing = await prisma.gcpResourceConfig.findUnique({ where: { resourceKey } })
    if (!existing) return null
    const mergedThresholds = update.thresholds
      ? { ...(existing.thresholdsJson as object), ...update.thresholds }
      : existing.thresholdsJson
    return prisma.gcpResourceConfig.update({
      where: { resourceKey },
      data: {
        ...(update.targetTierFor2x !== undefined ? { targetTierFor2x: update.targetTierFor2x } : {}),
        ...(update.suggestedNextTier !== undefined ? { suggestedNextTier: update.suggestedNextTier } : {}),
        ...(update.estimatedMonthlyCostUsd !== undefined
          ? { estimatedMonthlyCostUsd: update.estimatedMonthlyCostUsd }
          : {}),
        ...(update.runbookMarkdown !== undefined ? { runbookMarkdown: update.runbookMarkdown } : {}),
        thresholdsJson: (mergedThresholds ?? {}) as Prisma.InputJsonValue,
      },
    })
  },
}
