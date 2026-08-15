import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { SLOW_REPORT_TIMEOUT_MS } from '../../utils/requestTimeout'
import { csaManagementService } from '../../services/csaManagement.service'
import { adminViewService } from '../../services/adminView.service'
import { AssignViewsSchema } from '../../models/admin-view.schemas'
import {
  CreateCsaSchema,
  UpdateCsaSchema,
  SetCsaStatusSchema,
  ListCsasQuerySchema,
  ExportCsasQuerySchema,
  CsaIdParamsSchema,
  FailedLoginsQuerySchema,
  FailedLoginAttemptsQuerySchema,
  CsaTicketsQuerySchema,
  AddCsaIpSchema,
  CsaIpWhitelistIdParamsSchema,
} from '../../models/csa-admin.schemas'

const preAuth = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

/** SUPER_ADMIN management of customer-support (CSA) accounts. Prefix: /admin/support */
export default async function csaAdminRoutes(app: FastifyInstance) {
  app.post('/csas', { preHandler: preAuth }, async (req, reply) => {
    const body = parseRequest(CreateCsaSchema, req.body)
    const csa = await csaManagementService.createCsa(body, req.adminUser!.id)
    return reply.code(201).send({ csa })
  })

  app.get('/csas', { preHandler: preAuth }, async (req, reply) => {
    const query = parseRequest(ListCsasQuerySchema, req.query)
    const result = await csaManagementService.listCsas(query)
    return reply.send(result)
  })

  app.get('/csas/overview', { preHandler: preAuth }, async (_req, reply) => {
    const stats = await csaManagementService.getOverviewStats()
    return reply.send(stats)
  })

  /** Named CSA accounts with recent failed logins / active lockouts. */
  app.get('/csas/failed-logins', { preHandler: preAuth }, async (req, reply) => {
    const query = parseRequest(FailedLoginsQuerySchema, req.query)
    const result = await csaManagementService.listFailedLogins(query)
    return reply.send(result)
  })

  app.get('/csas/failed-login-attempts', { preHandler: preAuth }, async (req, reply) => {
    const query = parseRequest(FailedLoginAttemptsQuerySchema, req.query)
    const result = await csaManagementService.listFailedLoginAttempts(query)
    return reply.send(result)
  })

  app.get('/csas/export', { preHandler: preAuth, config: { timeoutMs: SLOW_REPORT_TIMEOUT_MS } }, async (req, reply) => {
    const query = parseRequest(ExportCsasQuerySchema, req.query)
    const { csv } = await csaManagementService.exportCsasCsv(query.status)
    const date = new Date().toISOString().slice(0, 10)
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header(
        'Content-Disposition',
        `attachment; filename="csa-export-${query.status ?? 'all'}-${date}.csv"`,
      )
      .send(csv)
  })

  app.get('/csas/:adminId', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const csa = await csaManagementService.getCsa(adminId)
    return reply.send({ csa })
  })

  app.patch('/csas/:adminId', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const body = parseRequest(UpdateCsaSchema, req.body)
    const csa = await csaManagementService.updateCsa(adminId, body)
    return reply.send({ csa })
  })

  app.patch('/csas/:adminId/status', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const body = parseRequest(SetCsaStatusSchema, req.body)
    const result = await csaManagementService.setStatus(adminId, body.status)
    return reply.send({ csa: result })
  })

  app.get('/csas/:adminId/stats', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const stats = await csaManagementService.getCsaStats(adminId)
    return reply.send({ adminId, stats })
  })

  /** All tickets (or closed/rated) for one CSA + avgRating summary. */
  app.get('/csas/:adminId/tickets', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const query = parseRequest(CsaTicketsQuerySchema, req.query)
    const result = await csaManagementService.listCsaTickets(adminId, query)
    return reply.send(result)
  })

  app.get('/csas/:adminId/ip-whitelist', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const result = await csaManagementService.listIpWhitelist(adminId)
    return reply.send(result)
  })

  app.post('/csas/:adminId/ip-whitelist', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const body = parseRequest(AddCsaIpSchema, req.body)
    const ip = await csaManagementService.addIp(adminId, body, req.adminUser!.id)
    return reply.code(201).send({ ip })
  })

  app.delete('/csas/:adminId/ip-whitelist/:whitelistId', { preHandler: preAuth }, async (req, reply) => {
    const { adminId, whitelistId } = parseRequest(CsaIpWhitelistIdParamsSchema, req.params)
    const result = await csaManagementService.removeIp(adminId, whitelistId)
    return reply.send(result)
  })

  // Views assigned to this CSA (empty = unrestricted legacy role-based access).
  app.get('/csas/:adminId/views', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    await csaManagementService.assertCsa(adminId)
    const result = await adminViewService.getAssignedViews(adminId)
    return reply.send({ adminId, ...result })
  })

  // Replace the CSA's assigned view set; [] clears all assignments.
  app.put('/csas/:adminId/views', { preHandler: preAuth }, async (req, reply) => {
    const { adminId } = parseRequest(CsaIdParamsSchema, req.params)
    const body = parseRequest(AssignViewsSchema, req.body)
    await csaManagementService.assertCsa(adminId)
    const result = await adminViewService.assignViews(adminId, body.views, req.adminUser!.id)
    return reply.send(result)
  })
}
