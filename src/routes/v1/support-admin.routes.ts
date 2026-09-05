import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import { adminAuditMetaFromRequest } from '../../utils/admin-audit'
import { parseRequest } from '../../utils/zod-request'
import { supportAdminService } from '../../services/supportAdmin.service'
import { supportReplyTemplateService } from '../../services/supportReplyTemplate.service'
import { csaNotificationService } from '../../services/csaNotification.service'
import { reportAdminService } from '../../services/reportAdmin.service'
import {
  AdminTicketListQuerySchema,
  AdminTicketParamsSchema,
  AdminTicketMessagesQuerySchema,
  AdminReplySchema,
  ResolveTicketSchema,
  AssignTicketSchema,
  SetPrioritySchema,
  CreateNoteSchema,
  AdminUploadUrlSchema,
  ReplyTemplateParamsSchema,
  CreateReplyTemplateSchema,
  UpdateReplyTemplateSchema,
  BulkResolveWithTemplateSchema,
  NotificationListQuerySchema,
  MarkNotificationsReadSchema,
  AdminReportListQuerySchema,
  AdminReportParamsSchema,
  ReviewReportSchema,
} from '../../models/support-admin.schemas'

/** Ticket workbench + notifications for CSAs; SUPER_ADMIN has full access. */
const csAuth = [authenticateAdmin, requireAdminRole('CUSTOMER_SUPPORT', 'SUPER_ADMIN')]
/** Report review additionally allows MODERATOR. */
const reportAuth = [
  authenticateAdmin,
  requireAdminRole('CUSTOMER_SUPPORT', 'SUPER_ADMIN', 'MODERATOR'),
]

function actorOf(req: FastifyRequest) {
  if (!req.adminUser) throw new AppError(401, 'Not authenticated as admin', 'ADMIN_TOKEN_MISSING')
  return { ...req.adminUser, request: adminAuditMetaFromRequest(req) }
}

/** Prefix: /admin/support */
export default async function supportAdminRoutes(app: FastifyInstance) {
  // --- Ticket workbench ---
  app.get('/tickets', { preHandler: csAuth }, async (req, reply) => {
    const query = parseRequest(AdminTicketListQuerySchema, req.query)
    const result = await supportAdminService.listTickets(actorOf(req), query)
    return reply.send(result)
  })

  app.get('/tickets/:ticketId', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const messageQuery = parseRequest(AdminTicketMessagesQuerySchema, req.query)
    const result = await supportAdminService.getTicketDetail(actorOf(req), ticketId, messageQuery)
    return reply.send(result)
  })

  app.post('/tickets/:ticketId/reply', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const body = parseRequest(AdminReplySchema, req.body)
    const message = await supportAdminService.reply(actorOf(req), ticketId, body)
    return reply.code(201).send({ message })
  })

  app.post('/tickets/:ticketId/resolve', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const body = parseRequest(ResolveTicketSchema, req.body)
    const ticket = await supportAdminService.resolve(actorOf(req), ticketId, body)
    return reply.send({ ticket })
  })

  app.post('/tickets/:ticketId/close', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const ticket = await supportAdminService.forceClose(actorOf(req), ticketId)
    return reply.send({ ticket })
  })

  app.post('/tickets/:ticketId/assign', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const body = parseRequest(AssignTicketSchema, req.body)
    const ticket = await supportAdminService.assign(actorOf(req), ticketId, body.adminId)
    return reply.send({ ticket })
  })

  app.post('/tickets/:ticketId/claim', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const ticket = await supportAdminService.claim(actorOf(req), ticketId)
    return reply.send({ ticket })
  })

  app.patch('/tickets/:ticketId/priority', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const body = parseRequest(SetPrioritySchema, req.body)
    const ticket = await supportAdminService.setPriority(actorOf(req), ticketId, body.priority)
    return reply.send({ ticket })
  })

  app.post('/tickets/:ticketId/star', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const result = await supportAdminService.setStar(actorOf(req), ticketId, true)
    return reply.send(result)
  })

  app.delete('/tickets/:ticketId/star', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const result = await supportAdminService.setStar(actorOf(req), ticketId, false)
    return reply.send(result)
  })

  app.get('/tickets/:ticketId/notes', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const result = await supportAdminService.listNotes(actorOf(req), ticketId)
    return reply.send(result)
  })

  app.post('/tickets/:ticketId/notes', { preHandler: csAuth }, async (req, reply) => {
    const { ticketId } = parseRequest(AdminTicketParamsSchema, req.params)
    const body = parseRequest(CreateNoteSchema, req.body)
    const note = await supportAdminService.addNote(actorOf(req), ticketId, body.content)
    return reply.code(201).send({ note })
  })

  app.post('/tickets/bulk-resolve-with-template', { preHandler: csAuth }, async (req, reply) => {
    const body = parseRequest(BulkResolveWithTemplateSchema, req.body)
    const result = await supportAdminService.bulkResolveWithTemplate(
      actorOf(req),
      body.ticketIds,
      body.templateId,
      body.resolution,
    )
    return reply.send(result)
  })

  // --- Reply templates ---
  app.get('/reply-templates', { preHandler: csAuth }, async (_req, reply) => {
    const result = await supportReplyTemplateService.list()
    return reply.send(result)
  })

  app.post('/reply-templates', { preHandler: csAuth }, async (req, reply) => {
    const body = parseRequest(CreateReplyTemplateSchema, req.body)
    const template = await supportReplyTemplateService.create(actorOf(req), body)
    return reply.code(201).send({ template })
  })

  app.patch('/reply-templates/:templateId', { preHandler: csAuth }, async (req, reply) => {
    const { templateId } = parseRequest(ReplyTemplateParamsSchema, req.params)
    const body = parseRequest(UpdateReplyTemplateSchema, req.body)
    const template = await supportReplyTemplateService.update(actorOf(req), templateId, body)
    return reply.send({ template })
  })

  app.delete('/reply-templates/:templateId', { preHandler: csAuth }, async (req, reply) => {
    const { templateId } = parseRequest(ReplyTemplateParamsSchema, req.params)
    const result = await supportReplyTemplateService.remove(actorOf(req), templateId)
    return reply.send(result)
  })

  app.post('/upload-url', { preHandler: csAuth }, async (req, reply) => {
    const body = parseRequest(AdminUploadUrlSchema, req.body)
    const result = await supportAdminService.getUploadUrl(actorOf(req), body)
    return reply.send(result)
  })

  app.get('/me/stats', { preHandler: csAuth }, async (req, reply) => {
    const stats = await supportAdminService.myStats(actorOf(req))
    return reply.send({ stats })
  })

  // --- Notifications (polling) ---
  app.get('/notifications', { preHandler: csAuth }, async (req, reply) => {
    const query = parseRequest(NotificationListQuerySchema, req.query)
    const result = await csaNotificationService.list(actorOf(req).id, query)
    return reply.send(result)
  })

  app.get('/notifications/badge', { preHandler: csAuth }, async (req, reply) => {
    const result = await csaNotificationService.badge(actorOf(req).id)
    return reply.send(result)
  })

  app.post('/notifications/read', { preHandler: csAuth }, async (req, reply) => {
    const body = parseRequest(MarkNotificationsReadSchema, req.body ?? {})
    const result = await csaNotificationService.markRead(actorOf(req).id, body.ids)
    return reply.send(result)
  })

  // --- User-report review ---
  app.get('/reports', { preHandler: reportAuth }, async (req, reply) => {
    const query = parseRequest(AdminReportListQuerySchema, req.query)
    const result = await reportAdminService.listReports(query)
    return reply.send(result)
  })

  app.get('/reports/:reportId', { preHandler: reportAuth }, async (req, reply) => {
    const { reportId } = parseRequest(AdminReportParamsSchema, req.params)
    const report = await reportAdminService.getReport(reportId)
    return reply.send({ report })
  })

  app.patch('/reports/:reportId/status', { preHandler: reportAuth }, async (req, reply) => {
    const { reportId } = parseRequest(AdminReportParamsSchema, req.params)
    const body = parseRequest(ReviewReportSchema, req.body)
    const report = await reportAdminService.reviewReport(actorOf(req), reportId, body)
    return reply.send({ report })
  })

  app.post('/reports/:reportId/escalate', { preHandler: csAuth }, async (req, reply) => {
    const { reportId } = parseRequest(AdminReportParamsSchema, req.params)
    const result = await reportAdminService.escalateToTicket(actorOf(req), reportId)
    return reply.code(201).send(result)
  })
}
