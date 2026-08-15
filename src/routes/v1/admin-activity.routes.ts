import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../middlewares/errorHandler'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { adminActivityListQuerySchema } from '../../models/admin-activity.schemas'
import { adminActivityService } from '../../services/adminActivity.service'

const preAuth = [authenticateAdmin]

function parseListQuery(query: unknown) {
  const parsed = adminActivityListQuerySchema.safeParse(query ?? {})
  if (!parsed.success) {
    throw new AppError(400, parsed.error.errors[0]?.message ?? 'Invalid query', 'INVALID_REQUEST')
  }
  return parsed.data
}

export default async function adminActivityRoutes(app: FastifyInstance) {
  app.get(
    '/activity-logs/action-types',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Activity'],
        description:
          'Admin action types for the Activity filter. Distinct values from audit_logs plus CSA workbench types (ADMIN_SUPPORT_TICKET_* / ADMIN_SUPPORT_REPORT_*).',
      },
    },
    async (_request, reply) => {
      return reply.send(await adminActivityService.listActionTypes())
    },
  )

  app.get(
    '/activity-logs/admins',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Activity'],
        description:
          'Active system admins (email + role) for the activity-log actor filter, including CUSTOMER_SUPPORT.',
      },
    },
    async (_request, reply) => {
      return reply.send(await adminActivityService.listAdmins())
    },
  )

  app.get(
    '/activity-logs',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Activity'],
        description:
          'Paginated admin activity audit log: admin actor, linked target user, IP, destination detail.',
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send(await adminActivityService.list(parseListQuery(request.query)))
    },
  )
}
