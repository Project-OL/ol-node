import { PointTxType, Prisma, RankingBoard } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { normalizeCountryOptional } from '../utils/agency-country'

/** Host earnings types that feed the HOST board. */
export const HOST_RANKING_TX_TYPES = new Set<PointTxType>([
  PointTxType.GIFT_RECEIVE,
  PointTxType.LIVESTREAM_GIFT,
  PointTxType.VIDEO_CALL,
  PointTxType.SUBSCRIPTION,
  PointTxType.GUARDIAN_PURCHASE,
])

/** Gift-received board (points). */
export const GIFT_RANKING_TX_TYPES = new Set<PointTxType>([
  PointTxType.GIFT_RECEIVE,
  PointTxType.LIVESTREAM_GIFT,
])

export type RankingScoreRow = {
  entityId: string
  totalScore: bigint
}

function dayDateOnly(day: Date): Date {
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()))
}

export const rankingRepository = {
  async resolveCountry(entityId: string, tx?: Prisma.TransactionClient): Promise<string | null> {
    const client = tx ?? prisma
    const u = await client.user.findUnique({
      where: { id: entityId },
      select: { country: true },
    })
    return normalizeCountryOptional(u?.country)
  },

  /**
   * Atomic delta upsert for a single UTC day. Floors score at 0.
   */
  async incrementScore(
    params: {
      board: RankingBoard
      entityId: string
      day: Date
      delta: bigint
      country?: string | null
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (params.delta === 0n) return
    const client = tx ?? prisma
    const day = dayDateOnly(params.day)
    const country =
      params.country !== undefined
        ? normalizeCountryOptional(params.country)
        : await rankingRepository.resolveCountry(params.entityId, client)

    await client.$executeRaw`
      INSERT INTO ranking_daily_scores (id, board, entity_id, day, score, country, updated_at)
      VALUES (
        gen_random_uuid(),
        ${params.board}::"RankingBoard",
        ${params.entityId}::uuid,
        ${day}::date,
        GREATEST(0, ${params.delta}),
        ${country},
        NOW()
      )
      ON CONFLICT (board, entity_id, day) DO UPDATE SET
        score = GREATEST(0, ranking_daily_scores.score + ${params.delta}),
        country = COALESCE(EXCLUDED.country, ranking_daily_scores.country),
        updated_at = NOW()
    `
  },

  async sumScoresInRange(params: {
    board: RankingBoard
    startDay: Date
    endDayExclusive: Date
    country?: string | null
    limit: number
    offset: number
  }): Promise<RankingScoreRow[]> {
    const country = normalizeCountryOptional(params.country ?? undefined)
    if (country) {
      return prismaRead.$queryRaw<RankingScoreRow[]>`
        SELECT entity_id AS "entityId", SUM(score)::bigint AS "totalScore"
        FROM ranking_daily_scores
        WHERE board = ${params.board}::"RankingBoard"
          AND day >= ${params.startDay}::date
          AND day < ${params.endDayExclusive}::date
          AND country ILIKE ${country}
        GROUP BY entity_id
        HAVING SUM(score) > 0
        ORDER BY SUM(score) DESC, entity_id ASC
        LIMIT ${params.limit}
        OFFSET ${params.offset}
      `
    }
    return prismaRead.$queryRaw<RankingScoreRow[]>`
      SELECT entity_id AS "entityId", SUM(score)::bigint AS "totalScore"
      FROM ranking_daily_scores
      WHERE board = ${params.board}::"RankingBoard"
        AND day >= ${params.startDay}::date
        AND day < ${params.endDayExclusive}::date
      GROUP BY entity_id
      HAVING SUM(score) > 0
      ORDER BY SUM(score) DESC, entity_id ASC
      LIMIT ${params.limit}
      OFFSET ${params.offset}
    `
  },

  async scoreForEntity(params: {
    board: RankingBoard
    entityId: string
    startDay: Date
    endDayExclusive: Date
    country?: string | null
  }): Promise<bigint> {
    const country = normalizeCountryOptional(params.country ?? undefined)
    if (country) {
      const rows = await prismaRead.$queryRaw<{ s: bigint }[]>`
        SELECT COALESCE(SUM(score), 0)::bigint AS s
        FROM ranking_daily_scores
        WHERE board = ${params.board}::"RankingBoard"
          AND entity_id = ${params.entityId}::uuid
          AND day >= ${params.startDay}::date
          AND day < ${params.endDayExclusive}::date
          AND country ILIKE ${country}
      `
      return rows[0]?.s ?? 0n
    }
    const rows = await prismaRead.$queryRaw<{ s: bigint }[]>`
      SELECT COALESCE(SUM(score), 0)::bigint AS s
      FROM ranking_daily_scores
      WHERE board = ${params.board}::"RankingBoard"
        AND entity_id = ${params.entityId}::uuid
        AND day >= ${params.startDay}::date
        AND day < ${params.endDayExclusive}::date
    `
    return rows[0]?.s ?? 0n
  },

  /** 1-based rank; null when score is 0. */
  async rankOfEntity(params: {
    board: RankingBoard
    entityId: string
    myScore: bigint
    startDay: Date
    endDayExclusive: Date
    country?: string | null
  }): Promise<number | null> {
    if (params.myScore <= 0n) return null
    const country = normalizeCountryOptional(params.country ?? undefined)
    const higher = country
      ? await prismaRead.$queryRaw<{ c: bigint }[]>`
          SELECT COUNT(*)::bigint AS c
          FROM (
            SELECT entity_id
            FROM ranking_daily_scores
            WHERE board = ${params.board}::"RankingBoard"
              AND day >= ${params.startDay}::date
              AND day < ${params.endDayExclusive}::date
              AND country ILIKE ${country}
            GROUP BY entity_id
            HAVING SUM(score) > ${params.myScore}
               OR (SUM(score) = ${params.myScore} AND entity_id < ${params.entityId}::uuid)
          ) sub
        `
      : await prismaRead.$queryRaw<{ c: bigint }[]>`
          SELECT COUNT(*)::bigint AS c
          FROM (
            SELECT entity_id
            FROM ranking_daily_scores
            WHERE board = ${params.board}::"RankingBoard"
              AND day >= ${params.startDay}::date
              AND day < ${params.endDayExclusive}::date
            GROUP BY entity_id
            HAVING SUM(score) > ${params.myScore}
               OR (SUM(score) = ${params.myScore} AND entity_id < ${params.entityId}::uuid)
          ) sub
        `
    return Number(higher[0]?.c ?? 0n) + 1
  },

  async scoreAtRank(params: {
    board: RankingBoard
    rank: number
    startDay: Date
    endDayExclusive: Date
    country?: string | null
  }): Promise<bigint | null> {
    if (params.rank < 1) return null
    const rows = await rankingRepository.sumScoresInRange({
      board: params.board,
      startDay: params.startDay,
      endDayExclusive: params.endDayExclusive,
      country: params.country,
      limit: 1,
      offset: params.rank - 1,
    })
    return rows[0]?.totalScore ?? null
  },

  async usersPublicFields(userIds: string[]) {
    if (userIds.length === 0) return []
    return prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        username: true,
        publicId: true,
        defaultPublicId: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        country: true,
        gender: true,
        dateOfBirth: true,
        privacyMysteryRank: true,
        walletUserLevels: {
          where: { levelType: { in: ['WEALTH', 'LIVESTREAM'] } },
          select: { levelType: true, currentLevel: true },
        },
      },
    })
  },
}
