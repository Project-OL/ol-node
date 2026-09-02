import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import {
  adminInfraCostByServiceQuerySchema,
  adminInfraCostInventoryQuerySchema,
} from '../../models/aws-infra-cost.schemas'
import { awsInfraCostService } from '../../services/aws-infra-cost.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * Admin AWS infra + cost dashboard. Live AWS calls (EC2/RDS/ElastiCache + Cost Explorer),
 * cached in Redis — see `INFRA_COST_INVENTORY_TTL` / `INFRA_COST_BY_SERVICE_TTL`.
 * GET /v1/admin/infra-cost/inventory
 * GET /v1/admin/infra-cost/by-service
 */
export default async function infraCostAdminRoutes(app: FastifyInstance) {
  const preHandler = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

  app.get(
    '/infra-cost/inventory',
    {
      preHandler,
      schema: {
        tags: ['Admin', 'Infra cost'],
        description:
          'Running EC2 instances, RDS instances, and ElastiCache clusters (live AWS call, cached ~15 min). `?refresh=true` bypasses the cache.',
        querystring: {
          type: 'object',
          properties: { refresh: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const query = parseRequest(adminInfraCostInventoryQuerySchema, request.query ?? {})
      const result = await awsInfraCostService.getInventory({ forceRefresh: query.refresh })
      return reply.send(result)
    },
  )

  app.get(
    '/infra-cost/by-service',
    {
      preHandler,
      schema: {
        tags: ['Admin', 'Infra cost'],
        description:
          'AWS Cost Explorer spend by service for a UTC calendar month (default: current). Cached ~1 hour — GetCostAndUsage is a billed API call. `?refresh=true` bypasses the cache.',
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
      const query = parseRequest(adminInfraCostByServiceQuerySchema, request.query ?? {})
      const result = await awsInfraCostService.getCostByService({
        year: query.year,
        month: query.month,
        forceRefresh: query.refresh,
      })
      return reply.send(result)
    },
  )
}
