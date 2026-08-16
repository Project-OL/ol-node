import { LevelType, Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { redisClient } from '../config/redis'
import { RedisKeys, USER_LEVEL_TTL, LEVEL_CONFIG_TTL } from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import { walletUserLevelRepository } from '../repositories/wallet-user-level.repository'

export type LevelSnapshot = {
  currentLevel: number
  cumulativeTotal: string
  nextLevelThreshold: string | null
  distanceToUpgrade: string | null
  progressNumerator: string
  progressDenominator: string | null
  leveledUp: boolean
  previousLevel: number
}

export type LevelThreshold = { level: number; threshold: bigint }

async function getThresholds(levelType: LevelType): Promise<LevelThreshold[]> {
  const redisKey =
    levelType === LevelType.WEALTH ? RedisKeys.levelConfigWealth() : RedisKeys.levelConfigStream()

  try {
    const cached = await redisClient.get(redisKey)
    if (cached) {
      const parsed = JSON.parse(cached) as { level: number; threshold: string }[]
      return parsed.map((r) => ({
        level: r.level,
        threshold: BigInt(r.threshold),
      }))
    }
  } catch {
    // fall through to DB
  }

  const configs = await walletUserLevelRepository.getConfigs(levelType)
  const thresholds: LevelThreshold[] = configs.map((c) => ({
    level: c.level,
    threshold: c.threshold,
  }))

  try {
    await redisClient.set(
      redisKey,
      JSON.stringify(
        thresholds.map((t) => ({
          level: t.level,
          threshold: t.threshold.toString(),
        })),
      ),
      'EX',
      LEVEL_CONFIG_TTL,
    )
  } catch {
    // ignore
  }

  return thresholds
}

/**
 * Highest level whose threshold <= cumulativeTotal. Thresholds must be sorted by level ascending.
 */
export function computeLevel(cumulativeTotal: bigint, thresholds: LevelThreshold[]): number {
  let level = 1
  for (const t of thresholds) {
    if (cumulativeTotal >= t.threshold) {
      level = t.level
    } else {
      break
    }
  }
  return level
}

function buildSnapshot(
  cumulativeTotal: bigint,
  currentLevel: number,
  previousLevel: number,
  thresholds: LevelThreshold[],
): LevelSnapshot {
  const nextConfig = thresholds.find((t) => t.level === currentLevel + 1)
  const currentThreshold = thresholds.find((t) => t.level === currentLevel)?.threshold ?? 0n
  const nextThreshold = nextConfig?.threshold ?? null

  const progressNumerator = cumulativeTotal - currentThreshold
  const progressDenominator = nextThreshold !== null ? nextThreshold - currentThreshold : null

  return {
    currentLevel,
    cumulativeTotal: cumulativeTotal.toString(),
    nextLevelThreshold: nextThreshold?.toString() ?? null,
    distanceToUpgrade: nextThreshold !== null ? (nextThreshold - cumulativeTotal).toString() : null,
    progressNumerator: progressNumerator.toString(),
    progressDenominator: progressDenominator?.toString() ?? null,
    leveledUp: currentLevel > previousLevel,
    previousLevel,
  }
}

export type LevelApplyResult = {
  newLevel: number
  previousLevel: number
  newCumulative: bigint
}

/** Write fresh snapshot to Redis after a successful applyCredit (call post-commit). */
export async function syncLevelCacheFromApplyResult(
  userId: string,
  levelType: LevelType,
  result: LevelApplyResult | null | undefined,
): Promise<void> {
  if (!result) return
  await walletLevelService.refreshCache(
    userId,
    levelType,
    result.newCumulative,
    result.newLevel,
    result.previousLevel,
  )
}

/** Drop cached snapshot so the next read reloads from DB (call post-commit). */
export async function bustLevelSnapshotCache(userId: string, levelType: LevelType): Promise<void> {
  await walletLevelService.invalidateCache(userId, levelType)
}

export const walletLevelService = {
  async getSnapshot(userId: string, levelType: LevelType): Promise<LevelSnapshot> {
    const redisKey =
      levelType === LevelType.WEALTH
        ? RedisKeys.userWealthLevel(userId)
        : RedisKeys.userLivestreamLevel(userId)

    try {
      const cached = await redisClient.get(redisKey)
      if (cached) {
        return JSON.parse(cached) as LevelSnapshot
      }
    } catch {
      // cold path
    }

    const [record, thresholds] = await Promise.all([
      walletUserLevelRepository.getOrCreate(userId, levelType),
      getThresholds(levelType),
    ])

    const snapshot = buildSnapshot(
      record.cumulativeTotal,
      record.currentLevel,
      record.currentLevel,
      thresholds,
    )
    snapshot.leveledUp = false

    try {
      await redisClient.set(redisKey, JSON.stringify(snapshot), 'EX', USER_LEVEL_TTL)
    } catch {
      // ignore
    }
    return snapshot
  },

  async applyCredit(
    tx: Prisma.TransactionClient,
    userId: string,
    levelType: LevelType,
    increment: bigint,
  ): Promise<{ newLevel: number; previousLevel: number; newCumulative: bigint }> {
    const current = await walletUserLevelRepository.getOrCreate(userId, levelType, tx, {
      lock: true,
    })

    const newCumulative = current.cumulativeTotal + increment
    const thresholds = await getThresholds(levelType)
    const newLevel = computeLevel(newCumulative, thresholds)
    const previousLevel = current.currentLevel

    await tx.walletUserLevel.update({
      where: { userId_levelType: { userId, levelType } },
      data: {
        cumulativeTotal: newCumulative,
        currentLevel: newLevel,
      },
    })

    return { newLevel, previousLevel, newCumulative }
  },

  /**
   * Undo XP previously added via `applyCredit` (admin transaction revert).
   * Cumulative is floored at 0; level is recomputed from thresholds (may level down).
   */
  async applyDebit(
    tx: Prisma.TransactionClient,
    userId: string,
    levelType: LevelType,
    decrement: bigint,
  ): Promise<{ newLevel: number; previousLevel: number; newCumulative: bigint }> {
    if (decrement <= 0n) {
      const current = await walletUserLevelRepository.getOrCreate(userId, levelType, tx, {
        lock: true,
      })
      return {
        newLevel: current.currentLevel,
        previousLevel: current.currentLevel,
        newCumulative: current.cumulativeTotal,
      }
    }

    const current = await walletUserLevelRepository.getOrCreate(userId, levelType, tx, {
      lock: true,
    })

    const newCumulative =
      current.cumulativeTotal > decrement ? current.cumulativeTotal - decrement : 0n
    const thresholds = await getThresholds(levelType)
    const newLevel = computeLevel(newCumulative, thresholds)
    const previousLevel = current.currentLevel

    await tx.walletUserLevel.update({
      where: { userId_levelType: { userId, levelType } },
      data: {
        cumulativeTotal: newCumulative,
        currentLevel: newLevel,
      },
    })

    return { newLevel, previousLevel, newCumulative }
  },

  async refreshCache(
    userId: string,
    levelType: LevelType,
    newCumulative: bigint,
    newLevel: number,
    previousLevel: number,
  ): Promise<LevelSnapshot> {
    const thresholds = await getThresholds(levelType)
    const snapshot = buildSnapshot(newCumulative, newLevel, previousLevel, thresholds)

    const redisKey =
      levelType === LevelType.WEALTH
        ? RedisKeys.userWealthLevel(userId)
        : RedisKeys.userLivestreamLevel(userId)

    try {
      await redisClient.set(redisKey, JSON.stringify(snapshot), 'EX', USER_LEVEL_TTL)
    } catch {
      // ignore
    }
    return snapshot
  },

  async invalidateCache(userId: string, levelType: LevelType) {
    const redisKey =
      levelType === LevelType.WEALTH
        ? RedisKeys.userWealthLevel(userId)
        : RedisKeys.userLivestreamLevel(userId)
    try {
      await redisClient.del(redisKey)
    } catch {
      // ignore
    }
  },

  async invalidateConfigCache() {
    try {
      await redisClient.del(RedisKeys.levelConfigWealth())
      await redisClient.del(RedisKeys.levelConfigStream())
    } catch {
      // ignore
    }
  },

  async getLevelTable(levelType: LevelType) {
    return getThresholds(levelType)
  },

  /**
   * Admin-only: set cumulative XP to the threshold of `targetLevel` (raise or lower).
   * Leaves the user at the start of that level so further XP progresses from there.
   */
  async setLevel(params: {
    userId: string
    levelType: LevelType
    targetLevel: number
  }): Promise<{
    levelType: LevelType
    previousLevel: number
    previousCumulative: string
    currentLevel: number
    cumulativeTotal: string
    snapshot: LevelSnapshot
  }> {
    const thresholds = await getThresholds(params.levelType)
    if (thresholds.length === 0) {
      throw new AppError(500, 'Level thresholds not configured', 'CONFIG_ERROR')
    }
    const maxLevel = thresholds[thresholds.length - 1]!.level
    if (
      !Number.isInteger(params.targetLevel) ||
      params.targetLevel < 1 ||
      params.targetLevel > maxLevel
    ) {
      throw new AppError(
        400,
        `targetLevel must be an integer between 1 and ${maxLevel}`,
        'INVALID_TARGET_LEVEL',
      )
    }
    const targetThreshold = thresholds.find((t) => t.level === params.targetLevel)?.threshold
    if (targetThreshold == null) {
      throw new AppError(400, 'Unknown target level', 'INVALID_TARGET_LEVEL')
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await walletUserLevelRepository.getOrCreate(
        params.userId,
        params.levelType,
        tx,
        { lock: true },
      )

      if (current.cumulativeTotal === targetThreshold) {
        throw new AppError(
          400,
          'User is already at the target level threshold',
          'LEVEL_ALREADY_AT_TARGET',
        )
      }

      const newCumulative = targetThreshold
      const newLevel = computeLevel(newCumulative, thresholds)
      const previousLevel = current.currentLevel

      await tx.walletUserLevel.update({
        where: {
          userId_levelType: { userId: params.userId, levelType: params.levelType },
        },
        data: {
          cumulativeTotal: newCumulative,
          currentLevel: newLevel,
        },
      })

      return {
        previousLevel,
        previousCumulative: current.cumulativeTotal.toString(),
        currentLevel: newLevel,
        cumulativeTotal: newCumulative.toString(),
        newCumulative,
      }
    })

    const snapshot = await walletLevelService.refreshCache(
      params.userId,
      params.levelType,
      result.newCumulative,
      result.currentLevel,
      result.previousLevel,
    )

    return {
      levelType: params.levelType,
      previousLevel: result.previousLevel,
      previousCumulative: result.previousCumulative,
      currentLevel: result.currentLevel,
      cumulativeTotal: result.cumulativeTotal,
      snapshot,
    }
  },

  /** @deprecated Prefer {@link setLevel} — same behavior (now allows raise or lower). */
  async setLevelIncreaseOnly(params: {
    userId: string
    levelType: LevelType
    targetLevel: number
  }) {
    return walletLevelService.setLevel(params)
  },

  /**
   * Batch-read wallet ledger display levels for social lists.
   * Uses Redis `level:wealth:*` / `level:stream:*` via pipeline; on miss loads via `getSnapshot`.
   */
  async getDisplayLevelsForUsers(
    userIds: string[],
  ): Promise<Map<string, { wealthLevel: number; livestreamLevel: number }>> {
    const unique = [...new Set(userIds)]
    const map = new Map<string, { wealthLevel: number; livestreamLevel: number }>()
    if (unique.length === 0) return map

    const redis = redisClient
    const pipe = redis.pipeline()
    for (const id of unique) {
      pipe.get(RedisKeys.userWealthLevel(id))
      pipe.get(RedisKeys.userLivestreamLevel(id))
    }
    let results: (string | null)[] = []
    try {
      const exec = await pipe.exec()
      if (exec && exec.length === unique.length * 2) {
        results = exec.map(([, v]) => v as string | null)
      } else {
        results = new Array(unique.length * 2).fill(null)
      }
    } catch {
      results = new Array(unique.length * 2).fill(null)
    }

    const missing: string[] = []
    for (let i = 0; i < unique.length; i++) {
      const uid = unique[i]!
      const wRaw = results[i * 2] ?? null
      const sRaw = results[i * 2 + 1] ?? null
      if (wRaw && sRaw) {
        try {
          const w = JSON.parse(wRaw) as LevelSnapshot
          const s = JSON.parse(sRaw) as LevelSnapshot
          map.set(uid, {
            wealthLevel: w.currentLevel,
            livestreamLevel: s.currentLevel,
          })
          continue
        } catch {
          /* fall through */
        }
      }
      missing.push(uid)
    }

    if (missing.length > 0) {
      // One query for all missing users (was 2 per-user getSnapshot round-trips).
      // Users without a wallet_user_levels row display the same defaults
      // getOrCreate would have returned (level 1, cumulative 0) — without the
      // incidental row creation on a read path.
      const [rows, wealthThresholds, streamThresholds] = await Promise.all([
        walletUserLevelRepository.getByUsersForTypes(missing, [
          LevelType.WEALTH,
          LevelType.LIVESTREAM,
        ]),
        getThresholds(LevelType.WEALTH),
        getThresholds(LevelType.LIVESTREAM),
      ])
      const rowByUserType = new Map<string, (typeof rows)[number]>()
      for (const row of rows) rowByUserType.set(`${row.userId}:${row.levelType}`, row)

      const writePipe = redis.pipeline()
      for (const uid of missing) {
        const w = rowByUserType.get(`${uid}:${LevelType.WEALTH}`)
        const s = rowByUserType.get(`${uid}:${LevelType.LIVESTREAM}`)
        const wSnap = buildSnapshot(
          w?.cumulativeTotal ?? 0n,
          w?.currentLevel ?? 1,
          w?.currentLevel ?? 1,
          wealthThresholds,
        )
        wSnap.leveledUp = false
        const sSnap = buildSnapshot(
          s?.cumulativeTotal ?? 0n,
          s?.currentLevel ?? 1,
          s?.currentLevel ?? 1,
          streamThresholds,
        )
        sSnap.leveledUp = false
        map.set(uid, {
          wealthLevel: wSnap.currentLevel,
          livestreamLevel: sSnap.currentLevel,
        })
        writePipe.set(RedisKeys.userWealthLevel(uid), JSON.stringify(wSnap), 'EX', USER_LEVEL_TTL)
        writePipe.set(
          RedisKeys.userLivestreamLevel(uid),
          JSON.stringify(sSnap),
          'EX',
          USER_LEVEL_TTL,
        )
      }
      try {
        await writePipe.exec()
      } catch {
        // best-effort cache write
      }
    }

    return map
  },
}
