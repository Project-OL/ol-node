import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { adminCountryAccessService } from '../../services/adminCountryAccess.service'
import {
  CountryAccessAdminParamsSchema,
  ReplaceCountryAccessSchema,
} from '../../models/admin-country-access.schemas'

const preAuth = [authenticateAdmin]
const superAdminOnly = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

/**
 * Per-admin country access grants for the country-scoped user search page.
 * Prefix: /admin. Guide: docs/flow-md/admin-country-user-search-flow.md
 */
export default async function adminCountryAccessRoutes(app: FastifyInstance) {
  // Caller's own granted countries — drives the search page's country picker.
  app.get('/country-access/me', { preHandler: preAuth }, async (req, reply) => {
    const result = await adminCountryAccessService.listForAdmin(req.adminUser!.id)
    return reply.send(result)
  })

  app.get('/country-access/:adminId', { preHandler: superAdminOnly }, async (req, reply) => {
    const { adminId } = parseRequest(CountryAccessAdminParamsSchema, req.params)
    const result = await adminCountryAccessService.listForAdmin(adminId)
    return reply.send(result)
  })

  // Replace the target admin's granted-country set entirely. Empty array clears all grants.
  app.put('/country-access/:adminId', { preHandler: superAdminOnly }, async (req, reply) => {
    const { adminId } = parseRequest(CountryAccessAdminParamsSchema, req.params)
    const body = parseRequest(ReplaceCountryAccessSchema, req.body)
    const result = await adminCountryAccessService.replaceForAdmin(
      adminId,
      body.countries,
      req.adminUser!.id,
    )
    return reply.send(result)
  })
}
