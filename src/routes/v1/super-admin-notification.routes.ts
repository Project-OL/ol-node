import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { superAdminNotificationService } from '../../services/superAdminNotification.service'
import {
  SuperAdminNotificationListQuerySchema,
  SuperAdminNotificationMarkReadBodySchema,
} from '../../models/super-admin-notification.schemas'

const superAdminOnly = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

/**
 * Polling notifications fired whenever any admin mutes live chat/audio,
 * disables messaging, or removes a profile picture. One row per SUPER_ADMIN
 * recipient, same shape as /admin/support/notifications for CSAs.
 * Prefix: /admin.
 */
export default async function superAdminNotificationRoutes(app: FastifyInstance) {
  app.get('/super-notifications', { preHandler: superAdminOnly }, async (req, reply) => {
    const query = parseRequest(SuperAdminNotificationListQuerySchema, req.query)
    const result = await superAdminNotificationService.list(req.adminUser!.id, query)
    return reply.send(result)
  })

  app.get('/super-notifications/badge', { preHandler: superAdminOnly }, async (req, reply) => {
    const result = await superAdminNotificationService.badge(req.adminUser!.id)
    return reply.send(result)
  })

  app.post('/super-notifications/read', { preHandler: superAdminOnly }, async (req, reply) => {
    const body = parseRequest(SuperAdminNotificationMarkReadBodySchema, req.body ?? {})
    const result = await superAdminNotificationService.markRead(req.adminUser!.id, body.ids)
    return reply.send(result)
  })
}
