import type { FastifyInstance } from 'fastify'
import { authenticateAdmin } from '../../middlewares/adminAuth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { adminCountryUserSearchService } from '../../services/adminCountryUserSearch.service'
import { AdminCountryUserSearchQuerySchema } from '../../models/admin-country-user-search.schemas'

const preAuth = [authenticateAdmin]

/**
 * Minimal, country-scoped user search for the country-restricted moderation
 * page. Never returns email/phone; `userId` is present only to target the
 * existing restriction/remove-avatar action endpoints and must not be
 * rendered by the panel. Prefix: /admin.
 * Guide: docs/flow-md/admin-country-user-search-flow.md
 */
export default async function adminCountryUserSearchRoutes(app: FastifyInstance) {
  app.get(
    '/users/country-search',
    {
      preHandler: preAuth,
      schema: {
        tags: ['Admin', 'Users'],
        description:
          'Search users by name/username within the caller’s granted countries. Returns only username, name, avatarUrl, publicId, and country — no email/phone. SUPER_ADMIN must pass an explicit country.',
      },
    },
    async (req, reply) => {
      const query = parseRequest(AdminCountryUserSearchQuerySchema, req.query)
      const result = await adminCountryUserSearchService.search(
        req.adminUser!.id,
        req.adminUser!.role,
        query,
      )
      return reply.send(result)
    },
  )
}
