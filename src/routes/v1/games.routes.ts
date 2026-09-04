import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate } from '../../middlewares/auth.middleware'
import { gameProviderService } from '../../services/gameProvider.service'
import {
  GameCatalogQuerySchema,
  GameLaunchParamsSchema,
  GameLaunchBodySchema,
} from '../../models/game.schemas'

export async function gamesRoutes(app: FastifyInstance) {
  app.get(
    '/',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = GameCatalogQuerySchema.parse(request.query)
      const games = await gameProviderService.listCatalog(
        (query.gameListType as 2 | 3 | undefined) ?? 3,
      )
      return reply.send({ games })
    },
  )

  app.post(
    '/:gameId/launch',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = GameLaunchParamsSchema.parse(request.params)
      const body = GameLaunchBodySchema.parse(request.body ?? {})
      const launch = await gameProviderService.launchGame(request.userId!, {
        gameId: params.gameId,
        roomId: body.roomId,
        gameMode: body.gameMode,
        language: body.language,
      })
      return reply.status(201).send(launch)
    },
  )
}
