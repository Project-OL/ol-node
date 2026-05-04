import {
  AGENCY_RANKING_CACHE_TTL,
  getRedisForRead,
  RedisKeys,
  redisClient,
} from "../config/redis";
import { agencyRepository } from "../repositories/agency.repository";

export type AgencyRankingPeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "ALL_TIME";

function encodeCursor(skip: number): string {
  return Buffer.from(JSON.stringify({ skip }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw) as { skip?: number };
    return typeof parsed.skip === "number" && parsed.skip >= 0 ? parsed.skip : 0;
  } catch {
    return 0;
  }
}

export const agencyRankingService = {
  /**
   * Phase 1: sorted by `totalHostsCount` DESC for every period (placeholder until Phase 2 earnings).
   */
  async getRanking(params: {
    period: AgencyRankingPeriod;
    limit: number;
    cursor?: string | null;
  }) {
    const limit = Math.min(Math.max(params.limit, 1), 100);
    const skip = decodeCursor(params.cursor ?? undefined);
    const cacheKey = RedisKeys.agencyRanking(
      params.period,
      limit,
      params.cursor ?? "",
    );

    try {
      const redis = getRedisForRead();
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as {
          period: AgencyRankingPeriod;
          items: unknown[];
          nextCursor: string | null;
        };
      }
    } catch {
      /* fall through */
    }

    const rows = await agencyRepository.listForRanking({
      limit,
      skip,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && page.length > 0 ? encodeCursor(skip + limit) : null;

    const payload = {
      period: params.period,
      items: page.map((r, i) => ({
        rank: skip + i + 1,
        agencyPublicId: r.defaultPublicId.toString(),
        agencyUserId: r.userId,
        displayName: r.displayName,
        totalHostsCount: r.totalHostsCount,
        lifetimeHostEarningsPoints: r.lifetimeHostEarningsPoints.toString(),
        currentLevel: r.currentLevel,
        paused: r.pausedAt != null,
      })),
      nextCursor,
    };

    try {
      await redisClient.set(
        cacheKey,
        JSON.stringify(payload),
        "EX",
        AGENCY_RANKING_CACHE_TTL,
      );
    } catch {
      /* ignore */
    }

    return payload;
  },
};
