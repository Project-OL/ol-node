import { Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { getQualifyingRewardEarningsForRange } from './rewardEarnings.repository'

export const royalHostRewardRepository = {
  async getClaimsForWeek(userId: string, weekStart: Date) {
    return prismaRead.royalHostRewardClaim.findMany({
      where: { userId, weekStart },
      select: { rewardType: true, pointsAmount: true, claimedAt: true },
    })
  },

  async insertClaim(
    data: {
      userId: string
      weekStart: Date
      rewardType: string
      pointsAmount: bigint
      ledgerEntryId: string
    },
    tx: Prisma.TransactionClient = prisma,
  ) {
    return tx.royalHostRewardClaim.create({ data })
  },

  getQualifyingEarningsForRange: getQualifyingRewardEarningsForRange,

  /** Keyset-cursor scan of users currently tagged 'royal host', ordered by id. */
  async listTaggedUsers({ cursor, limit }: { cursor: string; limit: number }): Promise<string[]> {
    const cursorClause = cursor === '' ? Prisma.sql`TRUE` : Prisma.sql`u.id > ${cursor}::uuid`
    const rows = await prismaRead.$queryRaw<Array<{ id: string }>>`
      SELECT u.id
      FROM users u
      WHERE 'royal host' = ANY(u.admin_tags)
        AND ${cursorClause}
      ORDER BY u.id
      LIMIT ${limit}
    `
    return rows.map((r) => r.id)
  },

  async getLatestEvaluation(userId: string, beforeWeekStart: Date) {
    return prismaRead.royalHostWeeklyEvaluation.findFirst({
      where: { userId, weekStart: { lt: beforeWeekStart } },
      orderBy: { weekStart: 'desc' },
      select: { consecutiveMissCountAfterThisWeek: true },
    })
  },

  async upsertEvaluation(data: {
    userId: string
    weekStart: Date
    earningsTotal: bigint
    targetMet: boolean
    consecutiveMissCountAfterThisWeek: number
    tagRevokedAfterThisWeek: boolean
  }) {
    return prisma.royalHostWeeklyEvaluation.upsert({
      where: { userId_weekStart: { userId: data.userId, weekStart: data.weekStart } },
      create: data,
      update: data,
    })
  },
}
