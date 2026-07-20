import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { adminViewService } from '../../services/adminView.service'
import {
  UpsertViewSchema,
  ReplaceViewEndpointsSchema,
  ViewNameParamsSchema,
} from '../../models/admin-view.schemas'

const superAdminOnly = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

/** Admin panel view catalog (view = named group of admin endpoints). Prefix: /admin */
export default async function adminViewRoutes(app: FastifyInstance) {
  app.get('/views', { preHandler: superAdminOnly }, async (_req, reply) => {
    const result = await adminViewService.listViews()
    return reply.send(result)
  })

  // Create a new view, or EXTEND an existing one (endpoint union — additive).
  app.post('/views', { preHandler: superAdminOnly }, async (req, reply) => {
    const body = parseRequest(UpsertViewSchema, req.body)
    const result = await adminViewService.upsertView(body, req.adminUser!.id)
    return reply.code(result.created ? 201 : 200).send(result)
  })

  // Replace a view's endpoint list entirely (the removal path).
  app.put('/views/:viewName', { preHandler: superAdminOnly }, async (req, reply) => {
    const { viewName } = parseRequest(ViewNameParamsSchema, req.params)
    const body = parseRequest(ReplaceViewEndpointsSchema, req.body)
    const result = await adminViewService.replaceViewEndpoints(viewName, body.endpoints)
    return reply.send(result)
  })

  // The caller's own views — what the admin panel renders for this login.
  // SUPER_ADMIN gets the full catalog; others get their assigned views.
  app.get('/views/me', { preHandler: [authenticateAdmin] }, async (req, reply) => {
    const admin = req.adminUser!
    if (admin.role === 'SUPER_ADMIN') {
      const { views } = await adminViewService.listViews()
      return reply.send({
        restricted: false,
        views: views.map((v) => ({ name: v.name, endpoints: v.endpoints })),
      })
    }
    const { views } = await adminViewService.getAssignedViews(admin.id)
    return reply.send({ restricted: views.length > 0, views })
  })
}
