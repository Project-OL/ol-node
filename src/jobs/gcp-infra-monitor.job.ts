/**
 * Hourly GCP infra usage monitor. Collects VM/Cloud SQL/Redis usage, persists a
 * snapshot per resource, evaluates each against its admin-configured thresholds, opens
 * or re-notifies `GcpInfraFlag` rows, and emails every active SUPER_ADMIN when
 * something needs attention — so action can be taken before a resource actually runs
 * out of headroom. See docs/flow-md/gcp-infra-monitor-flow.md.
 */

import { prisma } from '../config/database'
import { env } from '../config/env'
import { isGcpInfraMonitorConfigured } from '../config/gcp'
import { rootLogger } from '../utils/rootLogger'
import { systemAdminRepository } from '../repositories/systemAdmin.repository'
import { sesProvider } from '../services/providers/ses.provider'
import {
  collectCloudSqlMetrics,
  collectRedisMetrics,
  collectVmMetrics,
  evaluateThresholds,
  type FlagCandidate,
  type ThresholdConfig,
} from '../services/gcp-usage-monitor.service'
import type { GcpResourceConfig, GcpResourceType } from '@prisma/client'

const log = rootLogger.child({ module: 'gcp-infra-monitor-job' })

const SNAPSHOT_RETENTION_DAYS = 90

type CollectorSpecs = { gcpInstanceId?: string; gcpRegion?: string }

async function collectForResource(resource: GcpResourceConfig) {
  const specs = (resource.currentSpecsJson as CollectorSpecs | null) ?? {}
  const type: GcpResourceType = resource.resourceType
  switch (type) {
    case 'COMPUTE_VM':
      return collectVmMetrics()
    case 'CLOUD_SQL':
      if (!specs.gcpInstanceId) return { error: 'currentSpecsJson.gcpInstanceId not configured' }
      return collectCloudSqlMetrics(specs.gcpInstanceId)
    case 'MEMORYSTORE_REDIS':
      if (!specs.gcpInstanceId || !specs.gcpRegion) {
        return { error: 'currentSpecsJson.gcpInstanceId/gcpRegion not configured' }
      }
      return collectRedisMetrics(specs.gcpInstanceId, specs.gcpRegion)
    default:
      // LOAD_BALANCER / CLOUD_NAT / GCS_BUCKET — config/cost tracked, no usage collector yet.
      return { error: `No usage collector for resource type ${type}` }
  }
}

async function notifySuperAdmins(subject: string, text: string, html: string): Promise<void> {
  const superAdmins = await systemAdminRepository.findAllByRole('SUPER_ADMIN', 'ACTIVE')
  if (superAdmins.length === 0) {
    log.warn('No active SUPER_ADMINs found — GCP infra flag email not sent to anyone')
    return
  }
  for (const admin of superAdmins) {
    try {
      const result = await sesProvider.sendTransactionalEmail({
        email: admin.email,
        subject,
        text,
        html,
      })
      if (!result.success) {
        log.error({ adminId: admin.id, error: result.error }, 'GCP infra flag email failed')
      }
    } catch (err) {
      log.error({ err, adminId: admin.id }, 'GCP infra flag email threw')
    }
  }
}

function flagEmailBody(resource: GcpResourceConfig, candidate: FlagCandidate) {
  const subject = `[${candidate.severity}] GCP infra: ${resource.displayName} — ${candidate.metric}`
  const text = `${candidate.message}\n\nResource: ${resource.displayName} (${resource.resourceKey})\nCurrent tier: ${resource.currentTier}\n\nReview and act in the admin panel: GCP Infra & Cost > Flags.`
  const html = `
<!doctype html>
<html>
  <body>
    <p><strong>${candidate.severity}</strong> — ${candidate.message}</p>
    <p>Resource: <strong>${resource.displayName}</strong> (${resource.resourceKey})<br/>
    Current tier: ${resource.currentTier}</p>
    <p>Review and act in the admin panel: GCP Infra & Cost &gt; Flags.</p>
  </body>
</html>`.trim()
  return { subject, text, html }
}

async function upsertFlagAndMaybeNotify(
  resource: GcpResourceConfig,
  candidate: FlagCandidate,
  now: Date,
): Promise<void> {
  const existing = await prisma.gcpInfraFlag.findFirst({
    where: { resourceKey: resource.resourceKey, metric: candidate.metric, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    orderBy: { createdAt: 'desc' },
  })

  const renotifyMs = env.GCP_INFRA_ALERT_RENOTIFY_HOURS * 60 * 60 * 1000
  let shouldNotify = false
  let flagId: string

  if (existing) {
    const dueForRenotify =
      !existing.lastNotifiedAt || now.getTime() - existing.lastNotifiedAt.getTime() > renotifyMs
    await prisma.gcpInfraFlag.update({
      where: { id: existing.id },
      data: {
        value: candidate.value,
        threshold: candidate.threshold,
        severity: candidate.severity,
        message: candidate.message,
        ...(dueForRenotify ? { lastNotifiedAt: now } : {}),
      },
    })
    shouldNotify = dueForRenotify
    flagId = existing.id
  } else {
    const created = await prisma.gcpInfraFlag.create({
      data: {
        resourceKey: resource.resourceKey,
        metric: candidate.metric,
        value: candidate.value,
        threshold: candidate.threshold,
        severity: candidate.severity,
        status: 'OPEN',
        message: candidate.message,
        firstDetectedAt: now,
        lastNotifiedAt: now,
      },
    })
    shouldNotify = true
    flagId = created.id
  }

  if (shouldNotify) {
    const { subject, text, html } = flagEmailBody(resource, candidate)
    await notifySuperAdmins(subject, text, html)
    log.info({ flagId, resourceKey: resource.resourceKey, metric: candidate.metric }, 'GCP infra flag notified')
  }
}

async function autoResolveClearedFlags(resourceKey: string, currentMetrics: string[]): Promise<void> {
  // A metric that no longer appears in this run's candidate list is healthy again —
  // auto-resolve any open flag for it rather than leaving it stuck OPEN forever.
  await prisma.gcpInfraFlag.updateMany({
    where: {
      resourceKey,
      status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      metric: { notIn: currentMetrics },
    },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  })
}

export async function runGcpInfraMonitorJob(): Promise<void> {
  if (!isGcpInfraMonitorConfigured()) {
    log.debug('GCP_PROJECT_ID not set — skipping GCP infra monitor tick')
    return
  }

  const now = new Date()
  const resources = await prisma.gcpResourceConfig.findMany({ where: { isActive: true } })

  for (const resource of resources) {
    try {
      const metrics = await collectForResource(resource)
      await prisma.gcpUsageSnapshot.create({
        data: { resourceKey: resource.resourceKey, capturedAt: now, metricsJson: metrics },
      })

      if ('error' in metrics) {
        log.warn({ resourceKey: resource.resourceKey, error: metrics.error }, 'GCP metrics collection error')
        continue
      }

      const thresholds = (resource.thresholdsJson as ThresholdConfig | null) ?? {}
      const candidates = evaluateThresholds(metrics, thresholds)

      for (const candidate of candidates) {
        await upsertFlagAndMaybeNotify(resource, candidate, now)
      }
      await autoResolveClearedFlags(
        resource.resourceKey,
        candidates.map((c) => c.metric),
      )
    } catch (err) {
      log.error({ err, resourceKey: resource.resourceKey }, 'GCP infra monitor failed for resource')
    }
  }

  const cutoff = new Date(now.getTime() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000)
  const pruned = await prisma.gcpUsageSnapshot.deleteMany({ where: { capturedAt: { lt: cutoff } } })
  if (pruned.count > 0) {
    log.info({ pruned: pruned.count }, 'Pruned old GCP usage snapshots')
  }
}
