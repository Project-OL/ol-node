import { prisma, prismaRead } from '../config/database'
import { LevelType, Prisma } from '@prisma/client'

type WalletUserLevelDb = Prisma.TransactionClient | typeof prisma

export type WalletUserLevelRecord = {
  id: string
  userId: string
  levelType: LevelType
  currentLevel: number
  cumulativeTotal: bigint
  createdAt: Date
  updatedAt: Date
}

/**
 * Prisma `upsert` on `(user_id, level_type)` is SELECT-then-INSERT and races:
 * concurrent first writes throw P2002 Unique constraint failed on (`user_id`,`level_type`).
 * `ON CONFLICT DO NOTHING` is atomic and does not abort an open transaction.
 */
async function ensureRow(
  db: WalletUserLevelDb,
  userId: string,
  levelType: LevelType,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO wallet_user_levels (
      id, user_id, level_type, current_level, cumulative_total, created_at, updated_at
    )
    VALUES (
      gen_random_uuid(),
      ${userId}::uuid,
      ${levelType}::"LevelType",
      1,
      0,
      NOW(),
      NOW()
    )
    ON CONFLICT (user_id, level_type) DO NOTHING
  `
}

async function findRow(
  db: WalletUserLevelDb,
  userId: string,
  levelType: LevelType,
  lock: boolean,
): Promise<WalletUserLevelRecord> {
  const rows = lock
    ? await db.$queryRaw<WalletUserLevelRecord[]>`
        SELECT
          id,
          user_id AS "userId",
          level_type AS "levelType",
          current_level AS "currentLevel",
          cumulative_total AS "cumulativeTotal",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM wallet_user_levels
        WHERE user_id = ${userId}::uuid AND level_type = ${levelType}::"LevelType"
        FOR UPDATE
      `
    : await db.$queryRaw<WalletUserLevelRecord[]>`
        SELECT
          id,
          user_id AS "userId",
          level_type AS "levelType",
          current_level AS "currentLevel",
          cumulative_total AS "cumulativeTotal",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM wallet_user_levels
        WHERE user_id = ${userId}::uuid AND level_type = ${levelType}::"LevelType"
      `
  const row = rows[0]
  if (!row) {
    throw new Error(`wallet_user_levels missing after ensure (${userId}, ${levelType})`)
  }
  return row
}

export const walletUserLevelRepository = {
  async getOrCreate(
    userId: string,
    levelType: LevelType,
    db: WalletUserLevelDb = prisma,
    options?: { lock?: boolean },
  ): Promise<WalletUserLevelRecord> {
    await ensureRow(db, userId, levelType)
    return findRow(db, userId, levelType, options?.lock === true)
  },

  async getByUser(userId: string, levelType: LevelType) {
    return prismaRead.walletUserLevel.findUnique({
      where: { userId_levelType: { userId, levelType } },
    })
  },

  /** Multiple level rows (e.g. LIVESTREAM + WEALTH for /users/me) in one round-trip. */
  async getByUserForTypes(userId: string, levelTypes: LevelType[]) {
    return prismaRead.walletUserLevel.findMany({
      where: { userId, levelType: { in: levelTypes } },
    })
  },

  /** Level rows for many users in one round-trip (batch display enrichment). */
  async getByUsersForTypes(userIds: string[], levelTypes: LevelType[]) {
    if (userIds.length === 0) return []
    return prismaRead.walletUserLevel.findMany({
      where: { userId: { in: userIds }, levelType: { in: levelTypes } },
    })
  },

  async getConfigs(levelType: LevelType) {
    return prismaRead.walletLevelConfig.findMany({
      where: { levelType, isActive: true },
      orderBy: { level: 'asc' },
    })
  },

  async getAllConfigs() {
    return prismaRead.walletLevelConfig.findMany({
      where: { isActive: true },
      orderBy: [{ levelType: 'asc' }, { level: 'asc' }],
    })
  },
}
