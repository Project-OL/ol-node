import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { parseRequest } from '../../utils/zod-request'
import { BannerActiveQuerySchema } from '../../models/banner.schemas'
import { bannerService } from '../../services/banner.service'

export default async function bannerRoutes(app: FastifyInstance) {
  /**
   * Banners live right now (enabled + inside start/end window), shuffled on
   * every call. Optional ?position= free-text filter (e.g. home_top).
   */
  app.get(
    '/active',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = parseRequest(BannerActiveQuerySchema, request.query ?? {})
      const data = await bannerService.getActiveBanners(query)
      return reply.send(data)
    },
  )
}
