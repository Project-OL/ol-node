import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { accountDeletionAdminListQuerySchema } from '../../models/account-deletion-admin.schemas'
import { accountDeletionAdminService } from '../../services/accountDeletionAdmin.service'
import { auditService } from '../../services/audit.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * Admin review of scheduled account deletions.
 * GET  /v1/admin/account-deletions
 * GET  /v1/admin/account-deletions/:id
 * POST /v1/admin/account-deletions/:id/cancel
 */
export default async function accountDeletionAdminRoutes(app: FastifyInstance) {
  app.get(
    '/account-deletions',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Account deletion'],
        description:
          'List account deletion requests. Default status=open (requested, not cancelled or deleted).',
      },
    },
    async (request, reply) => {
      const query = parseRequest(accountDeletionAdminListQuerySchema, request.query ?? {})
      return reply.send(await accountDeletionAdminService.list(query))
    },
  )

  app.get(
    '/account-deletions/:id',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Account deletion'],
        description: 'Get one account deletion request with user contact details.',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      return reply.send(await accountDeletionAdminService.getById(id))
    },
  )

  app.post(
    '/account-deletions/:id/cancel',
    {
      preHandler: [authenticateAdmin],
      schema: {
        tags: ['Admin', 'Account deletion'],
        description: 'Cancel an open deletion request and reactivate the user (admin override).',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const adminUserId = request.adminUser?.id
      if (!adminUserId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const { id } = request.params as { id: string }
      const result = await accountDeletionAdminService.cancel(id, adminUserId)
      auditService.logAdminFromRequest(request, {
        actionType: 'ADMIN_ACCOUNT_DELETION_CANCELLED',
        targetUserId: result.userId,
        actionDetails: { deletionId: id },
        destination: `/admin/account-deletions/${id}`,
      })
      return reply.send(result)
    },
  )
}
