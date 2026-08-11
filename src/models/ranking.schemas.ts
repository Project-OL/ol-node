import { z } from 'zod'

export const RankingBoardParamSchema = z.enum(['host', 'rich', 'gift', 'agency'])
export type RankingBoardParam = z.infer<typeof RankingBoardParamSchema>

export const RankingPeriodSchema = z.enum(['DAILY', 'WEEKLY', 'MONTHLY'])
export type RankingPeriodParam = z.infer<typeof RankingPeriodSchema>

export const RankingListQuerySchema = z.object({
  period: RankingPeriodSchema,
  periodKey: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  country: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  cursor: z.string().min(1).optional(),
})

export const RankingPeriodsQuerySchema = z.object({
  period: RankingPeriodSchema,
})

export type RankingListQuery = z.infer<typeof RankingListQuerySchema>
