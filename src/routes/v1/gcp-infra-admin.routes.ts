import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  gcpInfraCostByServiceQuerySchema,
  gcpInfraFlagsQuerySchema,
  gcpInfraResourceHistoryQuerySchema,
  gcpResourceConfigUpdateSchema,
} from '../../models/gcp-infra-admin.schemas'
import { gcpBillingCostService } from '../../services/gcp-billing-cost.service'
import { gcpInfraAdminService } from '../../services/gcp-infra-admin.service'
import { auditService } from '../../services/audit.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * Admin GCP infra usage/cost/alerts dashboard. Hourly-collected usage (see
 * gcp-infra-monitor.job.ts), real billed cost from the GCP Billing Export
 * (BigQuery, cached), and open/resolved threshold flags.
 * GET  /v1/admin/gcp-infra/resources
 * GET  /v1/admin/gcp-infra/resources/:resourceKey/history
 * GET|PUT /v1/admin/gcp-infra/resources/:resourceKey/config
 * GET  /v1/admin/gcp-infra/cost-by-service
 * GET  /v1/admin/gcp-infra/flags
 * POST /v1/admin/gcp-infra/flags/:id/resolve
 */
export default async function gcpInfraAdminRoutes(app: FastifyInstance) {
  const preHandler = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

  app.get('/gcp-infra/resources', { preHandler }, async (_request, reply) => {
    return reply.send(await gcpInfraAdminService.listResourcesWithLatestUsage())
  })

  app.get(
    '/gcp-infra/resources/:resourceKey/history',
    { preHandler },
    async (request, reply) => {
      const { resourceKey } = request.params as { resourceKey: string }
      const query = parseRequest(gcpInfraResourceHistoryQuerySchema, request.query ?? {})
      return reply.send(await gcpInfraAdminService.getResourceHistory(resourceKey, query.range))
    },
  )

  app.get('/gcp-infra/resources/:resourceKey/config', { preHandler }, async (request, reply) => {
    const { resourceKey } = request.params as { resourceKey: string }
    const config = await gcpInfraAdminService.getResourceConfig(resourceKey)
    if (!config) throw new AppError(404, 'Resource not found', 'NOT_FOUND')
    return reply.send(config)
  })

  app.put('/gcp-infra/resources/:resourceKey/config', { preHandler }, async (request, reply) => {
    const adminUserId = request.adminUser?.id
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const { resourceKey } = request.params as { resourceKey: string }
    const body = parseRequest(gcpResourceConfigUpdateSchema, request.body ?? {})
    const updated = await gcpInfraAdminService.updateResourceConfig(resourceKey, body)
    if (!updated) throw new AppError(404, 'Resource not found', 'NOT_FOUND')
    auditService.logAdminFromRequest(request, {
      actionType: 'ADMIN_GCP_RESOURCE_CONFIG_UPDATED',
      actionDetails: { resourceKey },
    })
    return reply.send(updated)
  })

  app.get(
    '/gcp-infra/cost-by-service',
    {
      preHandler,
      schema: {
        tags: ['Admin', 'GCP infra cost'],
        description:
          'GCP Billing Export (BigQuery) spend by service for a UTC calendar month. Cached ~1 hour. `?refresh=true` bypasses the cache. Returns an `error` field instead of totals until the billing export has data.',
        querystring: {
          type: 'object',
          properties: {
            year: { type: 'integer', minimum: 2020, maximum: 2100 },
            month: { type: 'integer', minimum: 1, maximum: 12 },
            refresh: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(gcpInfraCostByServiceQuerySchema, request.query ?? {})
      const result = await gcpBillingCostService.getCostByService({
        year: query.year,
        month: query.month,
        forceRefresh: query.refresh,
      })
      return reply.send(result)
    },
  )

  app.get('/gcp-infra/flags', { preHandler }, async (request, reply) => {
    const query = parseRequest(gcpInfraFlagsQuerySchema, request.query ?? {})
    return reply.send(await gcpInfraAdminService.listFlags(query.status))
  })

  app.post('/gcp-infra/flags/:id/resolve', { preHandler }, async (request, reply) => {
    const adminUserId = request.adminUser?.id
    if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    const { id } = request.params as { id: string }
    const resolved = await gcpInfraAdminService.resolveFlag(id, adminUserId)
    auditService.logAdminFromRequest(request, {
      actionType: 'ADMIN_GCP_INFRA_FLAG_RESOLVED',
      actionDetails: { flagId: id },
    })
    return reply.send(resolved)
  })
}
