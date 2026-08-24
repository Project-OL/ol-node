import { PointTxType, Prisma, RankingBoard } from '@prisma/client'
import {
  PLATFORM_RANKING_DAY_TTL,
  PLATFORM_RANKING_WEEK_MONTH_TTL,
  RedisKeys,
  redisClient,
} from '../config/redis'
import { AppError } from '../middlewares/errorHandler'
import {
  GIFT_RANKING_TX_TYPES,
  HOST_RANKING_TX_TYPES,
  rankingRepository,
} from '../repositories/ranking.repository'
import { agencyRankingService } from './agencyRanking.service'
import { privacyService } from './privacy.service'
import { richTierService } from './rich-tier.service'
import { countryCacheKeySegment, normalizeCountryOptional } from '../utils/agency-country'
import { formatUserName } from '../utils/user-display'
import { utcDayFromTimestamp } from '../utils/datetime'
import {
  getPeriodKeys,
  isRankingPeriodKeyAllowed,
  listRankingPeriodOptions,
  rankingPeriodDayRange,
  rankingPeriodEndsAt,
  resolveRankingPeriodKey,
  type PlatformRankingPeriod,
} from '../utils/periodKeys'
import type { RankingBoardParam, RankingListQuery } from '../models/ranking.schemas'

const BOARD_MAP: Record<RankingBoardParam, RankingBoard> = {
  host: RankingBoard.HOST,
  gift: RankingBoard.GIFT,
  rich: RankingBoard.RICH,
  agency: RankingBoard.AGENCY,
}

function encodeCursor(skip: number): string {
  return Buffer.from(JSON.stringify({ skip }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as { skip?: number }
    return typeof parsed.skip === 'number' && parsed.skip >= 0 ? parsed.skip : 0
  } catch {
    return 0
  }
}

function gap(a: bigint, b: bigint): string {
  const d = a - b
  return (d > 0n ? d : 0n).toString()
}

function levelFromWallet(
  levels: { levelType: string; currentLevel: number }[],
  type: string,
): number {
  return levels.find((l) => l.levelType === type)?.currentLevel ?? 1
}

function computeAge(dob: Date | null | undefined): number | null {
  if (!dob) return null
  const today = new Date()
  let years = today.getUTCFullYear() - dob.getUTCFullYear()
  const m = today.getUTCMonth() - dob.getUTCMonth()
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) years--
  return years >= 0 ? years : null
}

export const rankingService = {
  boardFromParam(board: RankingBoardParam): RankingBoard {
    return BOARD_MAP[board]
  },

  async listPeriods(period: PlatformRankingPeriod) {
    return { period, options: listRankingPeriodOptions(period) }
  },

  async bumpEpoch(board: RankingBoard): Promise<void> {
    try {
      await redisClient.incr(RedisKeys.platformRankingEpoch(board))
    } catch {
      /* ignore */
    }
  },

  /**
   * Increment HOST / GIFT daily scores for a host point credit.
   * Safe inside or outside a Prisma transaction.
   */
  async onHostPointCredit(
    params: {
      hostUserId: string
      amount: bigint
      txType: PointTxType
      day?: Date
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (params.amount === 0n) return
    const day = params.day ?? utcDayFromTimestamp(new Date())
    const country = await rankingRepository.resolveCountry(params.hostUserId, tx)

    if (HOST_RANKING_TX_TYPES.has(params.txType)) {
      await rankingRepository.incrementScore(
        {
          board: RankingBoard.HOST,
          entityId: params.hostUserId,
          day,
          delta: params.amount,
          country,
        },
        tx,
      )
      void rankingService.bumpEpoch(RankingBoard.HOST)
    }
    if (GIFT_RANKING_TX_TYPES.has(params.txType)) {
      await rankingRepository.incrementScore(
        {
          board: RankingBoard.GIFT,
          entityId: params.hostUserId,
          day,
          delta: params.amount,
          country,
        },
        tx,
      )
      void rankingService.bumpEpoch(RankingBoard.GIFT)
    }
  },

  async onAgencyEarnings(
    params: {
      agencyUserId: string
      hostEarningsDelta: bigint
      day: Date
    },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (params.hostEarningsDelta === 0n) return
    const country = await rankingRepository.resolveCountry(params.agencyUserId, tx)
    await rankingRepository.incrementScore(
      {
        board: RankingBoard.AGENCY,
        entityId: params.agencyUserId,
        day: params.day,
        delta: params.hostEarningsDelta,
        country,
      },
      tx,
    )
    void rankingService.bumpEpoch(RankingBoard.AGENCY)
  },

  async onRecharge(
    params: { userId: string; coins: bigint; day?: Date },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (params.coins === 0n) return
    const day = params.day ?? utcDayFromTimestamp(new Date())
    const country = await rankingRepository.resolveCountry(params.userId, tx)
    await rankingRepository.incrementScore(
      {
        board: RankingBoard.RICH,
        entityId: params.userId,
        day,
        delta: params.coins,
        country,
      },
      tx,
    )
    void rankingService.bumpEpoch(RankingBoard.RICH)
  },

  async getBoard(params: {
    board: RankingBoardParam
    viewerUserId: string
    query: RankingListQuery
  }) {
    const board = BOARD_MAP[params.board]
    const period = params.query.period
    const periodKey = resolveRankingPeriodKey(period, params.query.periodKey)
    if (!isRankingPeriodKeyAllowed(period, periodKey)) {
      throw new AppError(
        400,
        'Invalid or out-of-range periodKey (must be within last 90 days)',
        'RANKING_INVALID_PERIOD',
      )
    }
    const range = rankingPeriodDayRange(period, periodKey)
    if (!range) {
      throw new AppError(400, 'Invalid periodKey for period', 'RANKING_INVALID_PERIOD')
    }
    const endsAt = rankingPeriodEndsAt(period, periodKey)!
    const country = normalizeCountryOptional(params.query.country)
    const limit = params.query.limit
    const skip = decodeCursor(params.query.cursor)
    const countryKey = country ? countryCacheKeySegment(country) : 'all'
    const cacheKey = RedisKeys.platformRanking(
      board,
      period,
      periodKey,
      countryKey,
      limit,
      params.query.cursor ?? '',
    )
    const ttl =
      period === 'DAILY' && periodKey === getPeriodKeys().dayKey
        ? PLATFORM_RANKING_DAY_TTL
        : PLATFORM_RANKING_WEEK_MONTH_TTL

    type CachedList = {
      epoch: string
      items: Array<{
        rank: number
        score: string
        entityId: string
        user?: Record<string, unknown>
        agency?: Record<string, unknown> | null
      }>
      nextCursor: string | null
    }

    let epoch = '0'
    try {
      epoch = (await redisClient.get(RedisKeys.platformRankingEpoch(board))) ?? '0'
    } catch {
      /* ignore */
    }

    let items: CachedList['items'] | null = null
    let nextCursor: string | null = null

    try {
      const raw = await redisClient.get(cacheKey)
      if (raw) {
        const parsed = JSON.parse(raw) as CachedList
        if (parsed.epoch === epoch) {
          items = parsed.items
          nextCursor = parsed.nextCursor
        }
      }
    } catch {
      /* miss */
    }

    if (!items) {
      const rows = await rankingRepository.sumScoresInRange({
        board,
        startDay: range.startDay,
        endDayExclusive: range.endDayExclusive,
        country,
        limit: limit + 1,
        offset: skip,
      })
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      nextCursor = hasMore ? encodeCursor(skip + limit) : null

      if (board === RankingBoard.AGENCY) {
        items = await Promise.all(
          page.map(async (row, i) => {
            try {
              const profile = await agencyRankingService.getPublicByUserId(row.entityId)
              return {
                rank: skip + i + 1,
                score: row.totalScore.toString(),
                entityId: row.entityId,
                agency: profile,
              }
            } catch {
              return {
                rank: skip + i + 1,
                score: row.totalScore.toString(),
                entityId: row.entityId,
                agency: {
                  agencyUserId: row.entityId,
                  userId: row.entityId,
                  displayName: '',
                  avatarUrl: null,
                },
              }
            }
          }),
        )
      } else {
        const users = await rankingRepository.usersPublicFields(page.map((r) => r.entityId))
        const byId = new Map(users.map((u) => [u.id, u]))
        const mystery =
          board === RankingBoard.RICH
            ? await privacyService.getEffectiveFlagsBulk(page.map((r) => r.entityId))
            : null

        let richTiers = new Map<string, number>()
        if (board === RankingBoard.RICH) {
          const snaps = await Promise.all(
            page.map(async (r) => {
              try {
                const s = await richTierService.getCurrentTierForUser(r.entityId)
                return [r.entityId, s.tier] as const
              } catch {
                return [r.entityId, 0] as const
              }
            }),
          )
          richTiers = new Map(snaps)
        }

        items = page.map((row, i) => {
          const u = byId.get(row.entityId)
          const mysteryOn = mystery?.get(row.entityId)?.mysteryOnRank === true
          const wealthLevel = u ? levelFromWallet(u.walletUserLevels, 'WEALTH') : 1
          const livestreamLevel = u ? levelFromWallet(u.walletUserLevels, 'LIVESTREAM') : 1
          const displayName = u ? formatUserName(u) : ''
          return {
            rank: skip + i + 1,
            score: row.totalScore.toString(),
            entityId: row.entityId,
            user: {
              userId: row.entityId,
              username: mysteryOn ? '****' : (u?.username ?? ''),
              displayName: mysteryOn ? 'Mystery' : displayName,
              name: mysteryOn ? '' : u ? formatUserName(u) : '',
              avatarUrl: mysteryOn ? null : (u?.avatarUrl ?? null),
              country: u?.country ?? null,
              gender: mysteryOn ? null : (u?.gender ?? null),
              age: mysteryOn ? null : computeAge(u?.dateOfBirth),
              wealthLevel,
              livestreamLevel,
              richTier:
                board === RankingBoard.RICH ? (richTiers.get(row.entityId) ?? 0) : undefined,
              mysteryRank: mysteryOn,
            },
          }
        })
      }

      try {
        await redisClient.setex(cacheKey, ttl, JSON.stringify({ epoch, items, nextCursor }))
      } catch {
        /* ignore */
      }
    }

    const meEntityId =
      board === RankingBoard.AGENCY
        ? params.viewerUserId // agency board ranks by agency owner userId
        : params.viewerUserId

    const myScore = await rankingRepository.scoreForEntity({
      board,
      entityId: meEntityId,
      startDay: range.startDay,
      endDayExclusive: range.endDayExclusive,
      country,
    })
    const myRank = await rankingRepository.rankOfEntity({
      board,
      entityId: meEntityId,
      myScore,
      startDay: range.startDay,
      endDayExclusive: range.endDayExclusive,
      country,
    })

    const [score1, score2, scoreAbove] = await Promise.all([
      rankingRepository.scoreAtRank({
        board,
        rank: 1,
        startDay: range.startDay,
        endDayExclusive: range.endDayExclusive,
        country,
      }),
      rankingRepository.scoreAtRank({
        board,
        rank: 2,
        startDay: range.startDay,
        endDayExclusive: range.endDayExclusive,
        country,
      }),
      myRank != null && myRank > 1
        ? rankingRepository.scoreAtRank({
            board,
            rank: myRank - 1,
            startDay: range.startDay,
            endDayExclusive: range.endDayExclusive,
            country,
          })
        : Promise.resolve(null),
    ])

    const distanceToNextRank =
      myRank === 1
        ? '0'
        : myRank != null && scoreAbove != null
          ? gap(scoreAbove, myScore)
          : score1 != null
            ? gap(score1, myScore)
            : '0'

    return {
      board: params.board,
      period,
      periodKey,
      country,
      endsAt: endsAt.toISOString(),
      items,
      nextCursor,
      me: {
        entityId: meEntityId,
        rank: myRank,
        score: myScore.toString(),
        distanceToNextRank,
        distanceToRank1: score1 != null ? gap(score1, myScore) : '0',
        distanceToRank2: score2 != null ? gap(score2, myScore) : '0',
      },
    }
  },
}
