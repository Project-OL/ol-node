import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { FanRankingQuerySchema } from '../../models/fan-ranking.schemas'
import { fanRankingService } from '../../services/fan-ranking.service'

export default async function fanRankingRoutes(app: FastifyInstance) {
  app.get(
    '/:hostUserId',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const hostUserId = (request.params as { hostUserId: string }).hostUserId
      const q = FanRankingQuerySchema.parse(request.query)
      const result = await fanRankingService.getRanking({
        hostUserId,
        viewerUserId: request.userId!,
        period: q.period,
      })
      return reply.send(result)
    },
  )
}
