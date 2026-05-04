import { describe, it, expect, vi, beforeEach } from "vitest";

const getAgencyWindowTotal = vi.fn();
const getLevelConfig = vi.fn();

vi.mock("../../src/repositories/agencyCommission.repository", () => ({
  agencyCommissionRepository: {
    getAgencyWindowTotal: (...a: unknown[]) => getAgencyWindowTotal(...a),
    getLevelConfig: (...a: unknown[]) => getLevelConfig(...a),
    listAgenciesForRecompute: vi.fn(),
  },
}));

const agencyFindUnique = vi.fn();
const agencyUpdate = vi.fn();

const $transaction = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
  prismaRead: {
    agency: {
      findUnique: (...a: unknown[]) => agencyFindUnique(...a),
    },
  },
}));

vi.mock("../../src/config/redis", () => ({
  redisClient: { del: vi.fn() },
  getRedisForRead: () => ({ get: vi.fn() }),
  RedisKeys: {
    agencyRate: (u: string) => `agency:rate:${u}`,
    agencyMe: (u: string) => `agency:me:${u}`,
    agencyLevelConfig: () => "agency:level:config",
  },
  AGENCY_COMMISSION_ME_CACHE_TTL: 60,
  AGENCY_LEVEL_CONFIG_CACHE_TTL: 3600,
  AGENCY_RATE_CACHE_TTL: 60,
}));

vi.mock("../../src/services/cacheRedis.service", () => ({
  cacheRedisService: {
    del: vi.fn(),
  },
}));

import { agencyCommissionService } from "../../src/services/agencyCommission.service";

beforeEach(() => {
  vi.clearAllMocks();
  getLevelConfig.mockResolvedValue([
    {
      level: "D",
      minWindowPoints: 0n,
      liveRateBp: 400,
      matchChatRateBp: 400,
      sortOrder: 1,
    },
    {
      level: "C",
      minWindowPoints: 1_500_000n,
      liveRateBp: 800,
      matchChatRateBp: 800,
      sortOrder: 2,
    },
    {
      level: "B",
      minWindowPoints: 7_500_000n,
      liveRateBp: 1200,
      matchChatRateBp: 1200,
      sortOrder: 3,
    },
    {
      level: "A",
      minWindowPoints: 35_000_000n,
      liveRateBp: 1600,
      matchChatRateBp: 1600,
      sortOrder: 4,
    },
    {
      level: "S",
      minWindowPoints: 100_000_000n,
      liveRateBp: 2000,
      matchChatRateBp: 2000,
      sortOrder: 5,
    },
    {
      level: "SS+",
      minWindowPoints: 250_000_000n,
      liveRateBp: 2400,
      matchChatRateBp: 2400,
      sortOrder: 6,
    },
  ]);
  $transaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
    const tx = { agency: { update: agencyUpdate } };
    return fn(tx);
  });
});

describe("agencyCommissionService.recomputeAgencyLevel", () => {
  it("idempotent: skips when lastLevelRecomputedAt is same UTC day", async () => {
    agencyFindUnique.mockResolvedValue({
      lastLevelRecomputedAt: new Date("2026-05-04T10:00:00.000Z"),
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T15:00:00.000Z"));
    await agencyCommissionService.recomputeAgencyLevel("ag-1");
    vi.useRealTimers();
    expect(getAgencyWindowTotal).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });

  it("skipDailyDedupe forces recompute", async () => {
    agencyFindUnique.mockResolvedValue({
      lastLevelRecomputedAt: new Date("2026-05-04T10:00:00.000Z"),
    });
    getAgencyWindowTotal.mockResolvedValue(2_000_000n);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T15:00:00.000Z"));
    await agencyCommissionService.recomputeAgencyLevel("ag-1", {
      skipDailyDedupe: true,
    });
    vi.useRealTimers();
    expect(getAgencyWindowTotal).toHaveBeenCalled();
    expect(agencyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "ag-1" },
        data: expect.objectContaining({
          currentLevel: "C",
          currentWindowTotalPoints: 2_000_000n,
        }),
      }),
    );
  });

  it("picks highest ladder tier whose min_window_points <= total", async () => {
    agencyFindUnique.mockResolvedValue({ lastLevelRecomputedAt: null });
    getAgencyWindowTotal.mockResolvedValue(36_000_000n);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    await agencyCommissionService.recomputeAgencyLevel("ag-1");
    vi.useRealTimers();
    expect(agencyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentLevel: "A" }),
      }),
    );
  });

  it("just below C stays D", async () => {
    agencyFindUnique.mockResolvedValue({ lastLevelRecomputedAt: null });
    getAgencyWindowTotal.mockResolvedValue(1_499_999n);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-04T12:00:00.000Z"));
    await agencyCommissionService.recomputeAgencyLevel("ag-1");
    vi.useRealTimers();
    expect(agencyUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentLevel: "D" }),
      }),
    );
  });
});
