import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  infraCapacityChangeSchema,
  infraCapacityOperationQuerySchema,
  infraCapacityStepUpSchema,
} from '../../models/infra-capacity.schemas'
import { auditService } from '../../services/audit.service'
import { infraCapacityService } from '../../services/infra-capacity.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * INF-23 admin capacity control (SUPER_ADMIN only). Flow: docs/flow-md/infra-capacity-flow.md
 * GET  /v1/admin/infra/capacity                    current API group + Redis, cooldown, history
 * POST /v1/admin/infra/capacity/step-up            ops password -> single-use token (5 min)
 * PUT  /v1/admin/infra/capacity                    { kind, ..., stepUpToken } -> ol-scaler
 * GET  /v1/admin/infra/capacity/operations?ref=    poll the GCP operation
 */
export default async function infraCapacityAdminRoutes(app: FastifyInstance) {
  const preHandler = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]
  const adminIdOf = (request: { adminUser?: { id?: string } }) => {
    const id = request.adminUser?.id
    if (!id) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
    return id
  }

  app.get('/infra/capacity', { preHandler }, async (request, reply) => {
    return reply.send(await infraCapacityService.getCapacity(adminIdOf(request)))
  })

  app.post('/infra/capacity/step-up', { preHandler }, async (request, reply) => {
    const adminId = adminIdOf(request)
    const body = parseRequest(infraCapacityStepUpSchema, request.body ?? {})
    try {
      const out = await infraCapacityService.stepUp(adminId, body.opsPassword)
      auditService.logAdminFromRequest(request, { actionType: 'ADMIN_INFRA_CAPACITY_STEP_UP' })
      return reply.send(out)
    } catch (err) {
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_INFRA_CAPACITY_STEP_UP',
        actionStatus: 'failed',
        actionDetails: { code: (err as AppError).code ?? 'ERROR' },
      })
      throw err
    }
  })

  app.put('/infra/capacity', { preHandler }, async (request, reply) => {
    const adminId = adminIdOf(request)
    const body = parseRequest(infraCapacityChangeSchema, request.body ?? {})
    const result = await infraCapacityService.change(adminId, body)
    const summary =
      result.request.kind === 'api'
        ? `API group min/max ${result.before.minReplicas}-${result.before.maxReplicas} -> ${result.request.minReplicas}-${result.request.maxReplicas}`
        : `Redis ${result.before.sizeGb} GB -> ${result.request.sizeGb} GB`
    auditService.logAdminFromRequest(request, {
      actionType: 'ADMIN_INFRA_CAPACITY_CHANGED',
      actionDetails: {
        summary,
        request: result.request,
        before: result.before,
        reason: result.reason,
        operation: result.operation,
      },
    })
    void infraCapacityService.notifyChange(adminId, summary).catch(() => {})
    return reply.send(result)
  })

  app.get('/infra/capacity/operations', { preHandler }, async (request, reply) => {
    const query = parseRequest(infraCapacityOperationQuerySchema, request.query ?? {})
    return reply.send(await infraCapacityService.operation(query.ref))
  })
}
