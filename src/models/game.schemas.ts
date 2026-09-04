import { z } from 'zod'

export const GameCatalogQuerySchema = z.object({
  // BAISHUN game_list_type: 2 = game, 3 = showroom (default).
  gameListType: z.coerce.number().int().refine((v) => v === 2 || v === 3).optional(),
})

export const GameLaunchParamsSchema = z.object({
  gameId: z.coerce.number().int().positive(),
})

export const GameLaunchBodySchema = z.object({
  roomId: z.string().max(100).optional(),
  gameMode: z.enum(['2', '3']).optional(),
  language: z.string().max(10).optional(),
})
