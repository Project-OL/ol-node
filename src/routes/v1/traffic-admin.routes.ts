import type { FastifyInstance } from 'fastify'
import { authenticateAdmin, requireAdminRole } from '../../middlewares/adminAuth.middleware'
import { trafficDayQuerySchema, trafficRangeQuerySchema } from '../../models/traffic-admin.schemas'
import { istToday, trafficAdminService } from '../../services/traffic-admin.service'
import { parseRequest } from '../../utils/zod-request'

/**
 * TRF-05: admin Traffic page (SUPER_ADMIN only). All days are IST.
 * GET /v1/admin/traffic/now               online now, live and calls now, this hour's sections
 * GET /v1/admin/traffic/day?date=         one day: minute series, peak / low / quiet window, sections
 * GET /v1/admin/traffic/range?days=7|30   per-day totals, hour-of-day heatmap, unique users, sections
 */
export default async function trafficAdminRoutes(app: FastifyInstance) {
  const preHandler = [authenticateAdmin, requireAdminRole('SUPER_ADMIN')]

  app.get('/traffic/now', { preHandler }, async (_request, reply) => {
    return reply.send(await trafficAdminService.now())
  })

  app.get('/traffic/day', { preHandler }, async (request, reply) => {
    const query = parseRequest(trafficDayQuerySchema, request.query ?? {})
    return reply.send(await trafficAdminService.day(query.date ?? istToday()))
  })

  app.get('/traffic/range', { preHandler }, async (request, reply) => {
    const query = parseRequest(trafficRangeQuerySchema, request.query ?? {})
    return reply.send(await trafficAdminService.range((query.days ?? 7) as 7 | 30))
  })
}
