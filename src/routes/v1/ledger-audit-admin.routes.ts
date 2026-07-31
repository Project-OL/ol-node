import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  ledgerAuditFlagListQuerySchema,
  ledgerAuditFlagPatchBodySchema,
} from '../../models/ledger-audit.schemas'
import { ledgerAuditAdminService } from '../../services/ledgerAuditAdmin.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * Admin overnight ledger / VIP irregularity flags.
 * GET  /v1/admin/ledger-audit/flags
 * PATCH /v1/admin/ledger-audit/flags/:id
 * POST /v1/admin/ledger-audit/run
 */
export default async function ledgerAuditAdminRoutes(app: FastifyInstance) {
  app.get(
    '/ledger-audit/flags',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Ledger audit'],
        description:
          'List wallet/VIP audit flags. Default status=OPEN. Search with q + qType=userId|publicId|displayId|auto.',
      },
    },
    async (request, reply) => {
      const query = parseRequest(ledgerAuditFlagListQuerySchema, request.query ?? {})
      const result = await ledgerAuditAdminService.listFlags(query)
      return reply.send(result)
    },
  )

  app.patch(
    '/ledger-audit/flags/:id',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Ledger audit'],
        description: 'Acknowledge, dismiss, or re-open an audit flag.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const { id } = request.params as { id: string }
      const body = parseRequest(ledgerAuditFlagPatchBodySchema, request.body ?? {})
      const result = await ledgerAuditAdminService.patchFlag({
        id,
        status: body.status,
        note: body.note,
        adminUserId,
      })
      return reply.send(result)
    },
  )

  app.post(
    '/ledger-audit/run',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Ledger audit'],
        description: 'Enqueue an immediate ledger/VIP audit scan (same job as the overnight cron).',
      },
    },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const result = await ledgerAuditAdminService.enqueueManualRun(adminUserId)
      return reply.code(202).send(result)
    },
  )
}
