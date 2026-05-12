import {
  AGENCY_RANKING_CACHE_TTL,
  getRedisForRead,
  RedisKeys,
  redisClient,
} from "../config/redis";
import { prismaRead } from "../config/database";
import { agencyRepository } from "../repositories/agency.repository";
import { walletLevelService } from "./user-level.service";

export type AgencyRankingPeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "ALL_TIME";

export type AgencyRankingItem = {
  rank: number;
  agencyPublicId: string;
  agencyUserId: string;
  userId: string;
  publicId: string | null;
  displayPublicId: string;
  gender: string | null;
  age: number | null;
  wealthLevel: number;
  livestreamLevel: number;
  agencyContactNumber: string | null;
  displayName: string;
  totalHostsCount: number;
  lifetimeHostEarningsPoints: string;
  currentLevel: string;
  paused: boolean;
};

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

function computeAgeFromDob(dob: Date | null | undefined): number | null {
  if (dob == null) return null;
  const today = new Date();
  let years = today.getFullYear() - dob.getFullYear();
  const m = today.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) {
    years--;
  }
  return years >= 0 ? years : null;
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
          items: AgencyRankingItem[];
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

    let items: AgencyRankingItem[] = [];
    if (page.length > 0) {
      const userIds = page.map((r) => r.userId);
      const [levelsMap, users, kycRows] = await Promise.all([
        walletLevelService.getDisplayLevelsForUsers(userIds),
        prismaRead.user.findMany({
          where: { id: { in: userIds } },
          select: {
            id: true,
            publicId: true,
            defaultPublicId: true,
            currentVipPublicId: true,
            gender: true,
            dateOfBirth: true,
          },
        }),
        prismaRead.agencyApplicationKyc.findMany({
          where: { userId: { in: userIds } },
          select: { userId: true, contactPhone: true },
        }),
      ]);
      const userById = new Map(users.map((u) => [u.id, u]));
      const phoneByUserId = new Map(
        kycRows.map((k) => [k.userId, k.contactPhone]),
      );
      items = page.map((r, i) => {
        const u = userById.get(r.userId);
        const lv = levelsMap.get(r.userId);
        const displayPublicId = u
          ? String(u.currentVipPublicId ?? u.defaultPublicId ?? u.publicId)
          : r.defaultPublicId.toString();
        return {
          rank: skip + i + 1,
          agencyPublicId: r.defaultPublicId.toString(),
          agencyUserId: r.userId,
          userId: r.userId,
          publicId: u ? String(u.publicId) : null,
          displayPublicId,
          gender: u?.gender ?? null,
          age: computeAgeFromDob(u?.dateOfBirth ?? null),
          wealthLevel: lv?.wealthLevel ?? 0,
          livestreamLevel: lv?.livestreamLevel ?? 0,
          agencyContactNumber: phoneByUserId.get(r.userId) ?? null,
          displayName: r.displayName,
          totalHostsCount: r.totalHostsCount,
          lifetimeHostEarningsPoints: r.lifetimeHostEarningsPoints.toString(),
          currentLevel: r.currentLevel,
          paused: r.pausedAt != null,
        };
      });
    }

    const payload = {
      period: params.period,
      items,
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
