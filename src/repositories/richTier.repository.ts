import { Prisma } from '@prisma/client'
import { prismaRead } from '../config/database'

export type UserRichTierRow = {
  userId: string
  currentTier: number
  evaluatedFromYear: number
  evaluatedFromMonth: number
  evaluatedRechargeCoins: bigint
  carryoverCoins: bigint
  lastRolledOverAt: Date | null
  updatedAt: Date
}

export type RichTierConfigRow = {
  tier: number
  minRechargeCoins: bigint
  displayName: string
}

export const richTierRepository = {
  async upsertMonthlyAggregate(
    {
      userId,
      year,
      month,
      deltaCoins,
    }: {
      userId: string
      year: number
      month: number
      deltaCoins: bigint
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO monthly_recharge_aggregates (
        user_id, year, month, total_recharge_coins, recharge_count, last_recharge_at
      )
      VALUES (
        ${userId}::uuid,
        ${year},
        ${month},
        ${deltaCoins},
        1,
        NOW()
      )
      ON CONFLICT (user_id, year, month) DO UPDATE SET
        total_recharge_coins = monthly_recharge_aggregates.total_recharge_coins + EXCLUDED.total_recharge_coins,
        recharge_count = monthly_recharge_aggregates.recharge_count + 1,
        last_recharge_at = NOW()
    `
  },

  async getMonthlyAggregate(
    userId: string,
    year: number,
    month: number,
  ): Promise<{
    totalRechargeCoins: bigint
    rechargeCount: number
    lastRechargeAt: Date
  } | null> {
    return richTierRepository.getMonthlyAggregateInTx(userId, year, month, prismaRead)
  },

  async getMonthlyAggregateInTx(
    userId: string,
    year: number,
    month: number,
    db: Prisma.TransactionClient | typeof prismaRead,
  ): Promise<{
    totalRechargeCoins: bigint
    rechargeCount: number
    lastRechargeAt: Date
  } | null> {
    const rows = await db.$queryRaw<
      {
        total_recharge_coins: bigint
        recharge_count: number
        last_recharge_at: Date
      }[]
    >`
      SELECT total_recharge_coins, recharge_count, last_recharge_at
      FROM monthly_recharge_aggregates
      WHERE user_id = ${userId}::uuid AND year = ${year} AND month = ${month}
      LIMIT 1
    `
    const r = rows[0]
    if (!r) return null
    return {
      totalRechargeCoins: r.total_recharge_coins,
      rechargeCount: r.recharge_count,
      lastRechargeAt: r.last_recharge_at,
    }
  },

  async getUserRichTier(userId: string): Promise<UserRichTierRow | null> {
    const row = await prismaRead.userRichTier.findUnique({
      where: { userId },
    })
    if (!row) return null
    return {
      userId: row.userId,
      currentTier: row.currentTier,
      evaluatedFromYear: row.evaluatedFromYear,
      evaluatedFromMonth: row.evaluatedFromMonth,
      evaluatedRechargeCoins: row.evaluatedRechargeCoins,
      carryoverCoins: row.carryoverCoins,
      lastRolledOverAt: row.lastRolledOverAt,
      updatedAt: row.updatedAt,
    }
  },

  async upsertUserRichTier(
    state: {
      userId: string
      currentTier: number
      evaluatedFromYear: number
      evaluatedFromMonth: number
      evaluatedRechargeCoins: bigint
      carryoverCoins: bigint
      lastRolledOverAt: Date
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.userRichTier.upsert({
      where: { userId: state.userId },
      create: {
        userId: state.userId,
        currentTier: state.currentTier,
        evaluatedFromYear: state.evaluatedFromYear,
        evaluatedFromMonth: state.evaluatedFromMonth,
        evaluatedRechargeCoins: state.evaluatedRechargeCoins,
        carryoverCoins: state.carryoverCoins,
        lastRolledOverAt: state.lastRolledOverAt,
      },
      update: {
        currentTier: state.currentTier,
        evaluatedFromYear: state.evaluatedFromYear,
        evaluatedFromMonth: state.evaluatedFromMonth,
        evaluatedRechargeCoins: state.evaluatedRechargeCoins,
        carryoverCoins: state.carryoverCoins,
        lastRolledOverAt: state.lastRolledOverAt,
      },
    })
  },

  async insertHistory(
    row: {
      userId: string
      year: number
      month: number
      tier: number
      totalProgressCoins: bigint
      carryoverApplied: bigint
      pureRechargeCoins: bigint
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO rich_tier_history (
        user_id, year, month, tier, total_progress_coins, carryover_applied, pure_recharge_coins
      )
      VALUES (
        ${row.userId}::uuid,
        ${row.year},
        ${row.month},
        ${row.tier},
        ${row.totalProgressCoins},
        ${row.carryoverApplied},
        ${row.pureRechargeCoins}
      )
      ON CONFLICT (user_id, year, month) DO NOTHING
    `
  },

  async historyExists(
    userId: string,
    year: number,
    month: number,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ ok: number }[]>`
      SELECT 1 AS ok
      FROM rich_tier_history
      WHERE user_id = ${userId}::uuid AND year = ${year} AND month = ${month}
      LIMIT 1
    `
    return rows.length > 0
  },

  async listUsersForRollover({
    year,
    month,
    cursor,
    limit,
  }: {
    year: number
    month: number
    cursor: string
    limit: number
  }): Promise<string[]> {
    const cursorClause = cursor === '' ? Prisma.sql`TRUE` : Prisma.sql`u.user_id > ${cursor}::uuid`
    const rows = await prismaRead.$queryRaw<{ user_id: string }[]>`
      SELECT user_id FROM (
        SELECT user_id FROM monthly_recharge_aggregates
        WHERE year = ${year} AND month = ${month}
        UNION
        SELECT user_id FROM user_rich_tier
      ) AS u
      WHERE ${cursorClause}
      ORDER BY user_id ASC
      LIMIT ${limit}
    `
    return rows.map((r) => r.user_id)
  },

  async listHistory(
    userId: string,
    limit: number,
    cursorYearMonth: { year: number; month: number } | null,
  ): Promise<
    Array<{
      year: number
      month: number
      tier: number
      totalProgressCoins: bigint
      carryoverApplied: bigint
      pureRechargeCoins: bigint
      createdAt: Date
    }>
  > {
    const before = cursorYearMonth
    const cursorFilter =
      before == null
        ? Prisma.sql``
        : Prisma.sql`AND (year < ${before.year} OR (year = ${before.year} AND month < ${before.month}))`
    const rows = await prismaRead.$queryRaw<
      Array<{
        year: number
        month: number
        tier: number
        total_progress_coins: bigint
        carryover_applied: bigint
        pure_recharge_coins: bigint
        created_at: Date
      }>
    >`
      SELECT year, month, tier, total_progress_coins, carryover_applied, pure_recharge_coins, created_at
      FROM rich_tier_history
      WHERE user_id = ${userId}::uuid
      ${cursorFilter}
      ORDER BY year DESC, month DESC
      LIMIT ${limit}
    `
    return rows.map((r) => ({
      year: r.year,
      month: r.month,
      tier: r.tier,
      totalProgressCoins: r.total_progress_coins,
      carryoverApplied: r.carryover_applied,
      pureRechargeCoins: r.pure_recharge_coins,
      createdAt: r.created_at,
    }))
  },

  async getConfig(): Promise<RichTierConfigRow[]> {
    const rows = await prismaRead.richTierConfig.findMany({
      orderBy: { tier: 'asc' },
    })
    return rows.map((r) => ({
      tier: r.tier,
      minRechargeCoins: r.minRechargeCoins,
      displayName: r.displayName,
    }))
  },
}
