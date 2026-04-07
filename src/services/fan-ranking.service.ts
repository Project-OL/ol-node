import {
  redisClient,
  getRedisForRead,
  RedisKeys,
  FAN_RANK_DAY_TTL,
  FAN_RANK_WEEK_MONTH_TTL,
} from "../config/redis";
import {
  fanRankingRepository,
  mapUserToRankingFields,
} from "../repositories/fan-ranking.repository";
import { getPeriodKeys } from "../utils/periodKeys";

function periodKeyFor(period: "day" | "week" | "month", keys: ReturnType<typeof getPeriodKeys>) {
  if (period === "day") return keys.dayKey;
  if (period === "week") return keys.weekKey;
  return keys.monthKey;
}

function ttlFor(period: "day" | "week" | "month") {
  return period === "day" ? FAN_RANK_DAY_TTL : FAN_RANK_WEEK_MONTH_TTL;
}

export const fanRankingService = {
  async getRanking(params: {
    hostUserId: string;
    viewerUserId: string;
    period: "day" | "week" | "month";
  }) {
    const keys = getPeriodKeys();
    const periodKey = periodKeyFor(params.period, keys);
    const cacheKey = RedisKeys.fanRanking(
      params.hostUserId,
      params.period,
      periodKey,
    );

    try {
      const redis = getRedisForRead();
      const raw = await redis.get(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          period: string;
          periodKey: string;
          rankings: unknown[];
        };
        const myCoinsSpent = await fanRankingRepository.senderSpendForPeriod({
          senderUserId: params.viewerUserId,
          receiverUserId: params.hostUserId,
          periodType: params.period,
          periodKey,
        });
        const myRank = await fanRankingRepository.rankOfSender({
          senderUserId: params.viewerUserId,
          receiverUserId: params.hostUserId,
          periodType: params.period,
          periodKey,
          myTotal: myCoinsSpent,
        });
        return {
          ...parsed,
          myRank,
          myCoinsSpent: myCoinsSpent.toString(),
        };
      }
    } catch {
      // compute
    }

    const top = await fanRankingRepository.topSendersBySpend({
      receiverUserId: params.hostUserId,
      periodType: params.period,
      periodKey,
      limit: 100,
    });

    const userIds = top.map((t) => t.senderUserId);
    const users = await fanRankingRepository.usersPublicFields(userIds);
    const byId = new Map(users.map((u) => [u.id, u]));

    const rankings = top.map((row, i) => {
      const u = byId.get(row.senderUserId);
      if (!u) {
        return {
          rank: i + 1,
          userId: row.senderUserId,
          username: "",
          displayName: "",
          avatarUrl: null as string | null,
          wealthLevel: 1,
          coinsSpent: row.totalCoins.toString(),
        };
      }
      const m = mapUserToRankingFields(u);
      return {
        rank: i + 1,
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
        avatarUrl: m.avatarUrl,
        wealthLevel: m.wealthLevel,
        coinsSpent: row.totalCoins.toString(),
      };
    });

    const myCoinsSpent = await fanRankingRepository.senderSpendForPeriod({
      senderUserId: params.viewerUserId,
      receiverUserId: params.hostUserId,
      periodType: params.period,
      periodKey,
    });
    const myRank = await fanRankingRepository.rankOfSender({
      senderUserId: params.viewerUserId,
      receiverUserId: params.hostUserId,
      periodType: params.period,
      periodKey,
      myTotal: myCoinsSpent,
    });

    const payload = {
      period: params.period,
      periodKey,
      rankings,
    };

    try {
      await redisClient.set(
        cacheKey,
        JSON.stringify(payload),
        "EX",
        ttlFor(params.period),
      );
    } catch {
      // ignore
    }

    return {
      ...payload,
      myRank,
      myCoinsSpent: myCoinsSpent.toString(),
    };
  },
};
