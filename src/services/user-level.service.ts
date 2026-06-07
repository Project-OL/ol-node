import { LevelType, Prisma } from '@prisma/client'
import { redisClient, getRedisForRead } from '../config/redis'
import { RedisKeys, USER_LEVEL_TTL, LEVEL_CONFIG_TTL } from '../config/redis'
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
    const redis = getRedisForRead()
    const cached = await redis.get(redisKey)
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

export const walletLevelService = {
  async getSnapshot(userId: string, levelType: LevelType): Promise<LevelSnapshot> {
    const redisKey =
      levelType === LevelType.WEALTH
        ? RedisKeys.userWealthLevel(userId)
        : RedisKeys.userLivestreamLevel(userId)

    try {
      const redis = getRedisForRead()
      const cached = await redis.get(redisKey)
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
    const current = await tx.walletUserLevel.upsert({
      where: { userId_levelType: { userId, levelType } },
      create: { userId, levelType, currentLevel: 1, cumulativeTotal: 0n },
      update: {},
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
   * Batch-read wallet ledger display levels for social lists.
   * Uses Redis `level:wealth:*` / `level:stream:*` via pipeline; on miss loads via `getSnapshot`.
   */
  async getDisplayLevelsForUsers(
    userIds: string[],
  ): Promise<Map<string, { wealthLevel: number; livestreamLevel: number }>> {
    const unique = [...new Set(userIds)]
    const map = new Map<string, { wealthLevel: number; livestreamLevel: number }>()
    if (unique.length === 0) return map

    const redis = getRedisForRead()
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

    await Promise.all(
      missing.map(async (uid) => {
        const [w, s] = await Promise.all([
          this.getSnapshot(uid, LevelType.WEALTH),
          this.getSnapshot(uid, LevelType.LIVESTREAM),
        ])
        map.set(uid, {
          wealthLevel: w.currentLevel,
          livestreamLevel: s.currentLevel,
        })
      }),
    )

    return map
  },
}
