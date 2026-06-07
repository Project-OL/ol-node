import {
  redisClient,
  getRedisForRead,
  RedisKeys,
  FAN_RANK_DAY_TTL,
  FAN_RANK_WEEK_MONTH_TTL,
} from '../config/redis'
import {
  fanRankingRepository,
  mapUserToRankingFields,
} from '../repositories/fan-ranking.repository'
import { getPeriodKeys } from '../utils/periodKeys'
import { privacyService } from './privacy.service'

function periodKeyFor(period: 'day' | 'week' | 'month', keys: ReturnType<typeof getPeriodKeys>) {
  if (period === 'day') return keys.dayKey
  if (period === 'week') return keys.weekKey
  return keys.monthKey
}

function ttlFor(period: 'day' | 'week' | 'month') {
  return period === 'day' ? FAN_RANK_DAY_TTL : FAN_RANK_WEEK_MONTH_TTL
}

const FETCH_MULT = 10
const FETCH_CAP = 500

function applyMysteryRankFilter<T extends { senderUserId: string }>(
  rows: T[],
  eff: Map<string, { mysteryOnRank: boolean }>,
): T[] {
  return rows.filter((row) => !eff.get(row.senderUserId)?.mysteryOnRank)
}

export const fanRankingService = {
  async getRanking(params: {
    hostUserId: string
    viewerUserId: string
    period: 'day' | 'week' | 'month'
  }) {
    const keys = getPeriodKeys()
    const periodKey = periodKeyFor(params.period, keys)
    const cacheKey = RedisKeys.fanRanking(params.hostUserId, params.period, periodKey)

    try {
      const redis = getRedisForRead()
      const raw = await redis.get(cacheKey)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          period: string
          periodKey: string
          rankings: unknown[]
        }
        const myCoinsSpent = await fanRankingRepository.senderSpendForPeriod({
          senderUserId: params.viewerUserId,
          receiverUserId: params.hostUserId,
          periodType: params.period,
          periodKey,
        })
        const myRank = await fanRankingRepository.rankOfSender({
          senderUserId: params.viewerUserId,
          receiverUserId: params.hostUserId,
          periodType: params.period,
          periodKey,
          myTotal: myCoinsSpent,
        })
        const ids = (parsed.rankings as { userId: string }[]).map((r) => r.userId)
        const eff = await privacyService.getEffectiveFlagsBulk(ids)
        const rankings = (
          parsed.rankings as {
            rank: number
            userId: string
            username: string
            displayName: string
            avatarUrl: string | null
            wealthLevel: number
            coinsSpent: string
          }[]
        )
          .filter((r) => !eff.get(r.userId)?.mysteryOnRank)
          .map((r, i) => ({ ...r, rank: i + 1 }))
        return {
          period: parsed.period,
          periodKey: parsed.periodKey,
          rankings,
          myRank,
          myCoinsSpent: myCoinsSpent.toString(),
        }
      }
    } catch {
      // compute
    }

    const rawLimit = Math.min(FETCH_CAP, 100 * FETCH_MULT)
    const topRaw = await fanRankingRepository.topSendersBySpend({
      receiverUserId: params.hostUserId,
      periodType: params.period,
      periodKey,
      limit: rawLimit,
    })
    const effTop = await privacyService.getEffectiveFlagsBulk(topRaw.map((t) => t.senderUserId))
    const top = applyMysteryRankFilter(topRaw, effTop).slice(0, 100)

    const userIds = top.map((t) => t.senderUserId)
    const users = await fanRankingRepository.usersPublicFields(userIds)
    const byId = new Map(users.map((u) => [u.id, u]))

    const rankings = top.map((row, i) => {
      const u = byId.get(row.senderUserId)
      if (!u) {
        return {
          rank: i + 1,
          userId: row.senderUserId,
          username: '',
          displayName: '',
          avatarUrl: null as string | null,
          wealthLevel: 1,
          coinsSpent: row.totalCoins.toString(),
        }
      }
      const m = mapUserToRankingFields(u)
      return {
        rank: i + 1,
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
        wealthLevel: m.wealthLevel,
        coinsSpent: row.totalCoins.toString(),
      }
    })

    const myCoinsSpent = await fanRankingRepository.senderSpendForPeriod({
      senderUserId: params.viewerUserId,
      receiverUserId: params.hostUserId,
      periodType: params.period,
      periodKey,
    })
    const myRank = await fanRankingRepository.rankOfSender({
      senderUserId: params.viewerUserId,
      receiverUserId: params.hostUserId,
      periodType: params.period,
      periodKey,
      myTotal: myCoinsSpent,
    })

    const payload = {
      period: params.period,
      periodKey,
      rankings,
    }

    try {
      await redisClient.set(cacheKey, JSON.stringify(payload), 'EX', ttlFor(params.period))
    } catch {
      // ignore
    }

    return {
      ...payload,
      myRank,
      myCoinsSpent: myCoinsSpent.toString(),
    }
  },
}
