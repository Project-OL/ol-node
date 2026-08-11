import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { AppError } from '../../middlewares/errorHandler'
import {
  RankingBoardParamSchema,
  RankingListQuerySchema,
  RankingPeriodsQuerySchema,
} from '../../models/ranking.schemas'
import { rankingService } from '../../services/ranking.service'

export default async function rankingRoutes(app: FastifyInstance) {
  app.get(
    '/periods',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = RankingPeriodsQuerySchema.parse(request.query ?? {})
      return reply.send(await rankingService.listPeriods(q.period))
    },
  )

  app.get(
    '/:board',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const boardRaw = (request.params as { board: string }).board
      const boardParsed = RankingBoardParamSchema.safeParse(boardRaw)
      if (!boardParsed.success) {
        throw new AppError(400, 'Invalid board (host|rich|gift|agency)', 'RANKING_INVALID_BOARD')
      }
      const userId = (request as { userId?: string }).userId
      if (!userId) throw new AppError(401, 'Unauthorized', 'UNAUTHORIZED')
      const query = RankingListQuerySchema.parse(request.query ?? {})
      const result = await rankingService.getBoard({
        board: boardParsed.data,
        viewerUserId: userId,
        query,
      })
      return reply.send(result)
    },
  )
}
