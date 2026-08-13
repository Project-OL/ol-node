import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { CoinTxType } from "@prisma/client";

const historyExists = vi.fn();
const upsertUserRichTier = vi.fn();
const upsertMonthlyAggregate = vi.fn();
const getMonthlyAggregateInTx = vi.fn();
const insertHistory = vi.fn();
const getUserRichTier = vi.fn();
const getMonthlyAggregate = vi.fn();
const getConfig = vi.fn();
const replaceConfig = vi.fn();
const listHistory = vi.fn();

vi.mock("../../src/repositories/richTier.repository", () => ({
  richTierRepository: {
    upsertMonthlyAggregate: (...a: unknown[]) => upsertMonthlyAggregate(...a),
    getMonthlyAggregateInTx: (...a: unknown[]) => getMonthlyAggregateInTx(...a),
    getMonthlyAggregate: (...a: unknown[]) => getMonthlyAggregate(...a),
    getUserRichTier: (...a: unknown[]) => getUserRichTier(...a),
    upsertUserRichTier: (...a: unknown[]) => upsertUserRichTier(...a),
    insertHistory: (...a: unknown[]) => insertHistory(...a),
    historyExists: (...a: unknown[]) => historyExists(...a),
    listHistory: (...a: unknown[]) => listHistory(...a),
    getConfig: (...a: unknown[]) => getConfig(...a),
    replaceConfig: (...a: unknown[]) => replaceConfig(...a),
  },
}));

const findMostRecent = vi.fn();
vi.mock("../../src/repositories/vip-assignment.repository", () => ({
  vipAssignmentRepository: {
    findMostRecent: (...a: unknown[]) => findMostRecent(...a),
  },
}));

const redisGet = vi.fn();
const redisSet = vi.fn();
const redisDel = vi.fn();

vi.mock("../../src/config/redis", async () => {
  const actual = await vi.importActual<typeof import("../../src/config/redis")>(
    "../../src/config/redis",
  );
  return {
    ...actual,
    getRedisForRead: () => ({
      get: (...a: unknown[]) => redisGet(...a),
    }),
    redisClient: {
      get: (...a: unknown[]) => redisGet(...a),
      set: (...a: unknown[]) => redisSet(...a),
      del: (...a: unknown[]) => redisDel(...a),
    },
  };
});

const $transaction = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
  prismaRead: {},
}));

vi.mock("../../src/services/ranking.service", () => ({
  rankingService: {
    onRecharge: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  computeTier,
  defaultRichTierLadder,
  RECHARGE_TX_TYPES,
  richTierService,
  RICH_TIER_THRESHOLDS,
} from "../../src/services/rich-tier.service";

describe("richTierService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
    getConfig.mockResolvedValue(
      defaultRichTierLadder().map((r) => ({
        tier: r.tier,
        minRechargeCoins: r.minRechargeCoins,
        displayName: r.displayName,
      })),
    );
    findMostRecent.mockResolvedValue(null);
  });

  it("RECHARGE_TX_TYPES contains exactly TOPUP, TRADING_TRANSFER_IN, ADJUSTMENT", () => {
    expect(RECHARGE_TX_TYPES.has(CoinTxType.TOPUP)).toBe(true);
    expect(RECHARGE_TX_TYPES.has(CoinTxType.TRADING_TRANSFER_IN)).toBe(true);
    expect(RECHARGE_TX_TYPES.has(CoinTxType.ADJUSTMENT)).toBe(true);
    expect(RECHARGE_TX_TYPES.size).toBe(3);
  });

  it("getCurrentTierForUser sets badgeVisible false when not VIP", async () => {
    getUserRichTier.mockResolvedValue(null);
    getMonthlyAggregate.mockResolvedValue(null);
    const out = await richTierService.getCurrentTierForUser("u1");
    expect(out.badgeVisible).toBe(false);
    expect(out.tier).toBe(0);
    expect(out.level).toBe(0);
    expect(out.amount).toBe("0");
    expect(out.currentMonthProgressCoins).toBe("0");
  });

  it("getCurrentTierForUser sets badgeVisible when VIP and tier > 0", async () => {
    getUserRichTier.mockResolvedValue({
      userId: "u1",
      currentTier: 1,
      evaluatedFromYear: 0,
      evaluatedFromMonth: 0,
      evaluatedRechargeCoins: 0n,
      carryoverCoins: 0n,
      lastRolledOverAt: null,
      updatedAt: new Date(),
    });
    getMonthlyAggregate.mockResolvedValue({
      totalRechargeCoins: 5_000_000n,
      rechargeCount: 1,
      lastRechargeAt: new Date(),
    });
    findMostRecent.mockResolvedValue({
      isActive: true,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const out = await richTierService.getCurrentTierForUser("u1");
    expect(out.tier).toBe(1);
    expect(out.level).toBe(1);
    expect(out.amount).toBe("5000000");
    expect(out.currentMonthProgressCoins).toBe("5000000");
    expect(out.badgeVisible).toBe(true);
  });

  it("applyRecharge writes live badge tier when recharge crosses threshold", async () => {
    const userRichTierUpsert = vi.fn();
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ country: "US" }),
      },
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({ currentTier: 0, carryoverCoins: 0n }),
        upsert: userRichTierUpsert,
      },
    } as unknown as Prisma.TransactionClient;

    upsertMonthlyAggregate.mockResolvedValue(undefined);
    getMonthlyAggregateInTx.mockResolvedValue({
      totalRechargeCoins: 3_000_000n,
      rechargeCount: 1,
      lastRechargeAt: new Date(),
    });

    await richTierService.applyRecharge("u1", 3_000_000n, tx);

    expect(upsertMonthlyAggregate).toHaveBeenCalled();
    expect(userRichTierUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1" },
        create: expect.objectContaining({ currentTier: 1, carryoverCoins: 0n }),
        update: { currentTier: 1 },
      }),
    );
  });

  it("applyRecharge skips user_rich_tier write when tier unchanged", async () => {
    const userRichTierUpsert = vi.fn();
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ country: "US" }),
      },
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({ currentTier: 2, carryoverCoins: 0n }),
        upsert: userRichTierUpsert,
      },
    } as unknown as Prisma.TransactionClient;

    upsertMonthlyAggregate.mockResolvedValue(undefined);
    getMonthlyAggregateInTx.mockResolvedValue({
      totalRechargeCoins: 6_000_000n,
      rechargeCount: 2,
      lastRechargeAt: new Date(),
    });

    await richTierService.applyRecharge("u1", 1_000_000n, tx);

    expect(userRichTierUpsert).not.toHaveBeenCalled();
  });

  it("applyRecharge can jump multiple tiers in one recharge", async () => {
    const userRichTierUpsert = vi.fn();
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue({ country: "US" }),
      },
      $executeRaw: vi.fn().mockResolvedValue(undefined),
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({ currentTier: 0, carryoverCoins: 0n }),
        upsert: userRichTierUpsert,
      },
    } as unknown as Prisma.TransactionClient;

    upsertMonthlyAggregate.mockResolvedValue(undefined);
    getMonthlyAggregateInTx.mockResolvedValue({
      totalRechargeCoins: 11_000_000n,
      rechargeCount: 1,
      lastRechargeAt: new Date(),
    });

    await richTierService.applyRecharge("u1", 11_000_000n, tx);

    expect(userRichTierUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ currentTier: 3 }),
        update: { currentTier: 3 },
      }),
    );
  });

  it("getCurrentTierForUser returns persisted currentTier for badge", async () => {
    getUserRichTier.mockResolvedValue({
      userId: "u1",
      currentTier: 3,
      evaluatedFromYear: 2026,
      evaluatedFromMonth: 4,
      evaluatedRechargeCoins: 0n,
      carryoverCoins: 0n,
      lastRolledOverAt: null,
      updatedAt: new Date(),
    });
    getMonthlyAggregate.mockResolvedValue({
      totalRechargeCoins: 999_999_999_999n,
      rechargeCount: 1,
      lastRechargeAt: new Date(),
    });
    const out = await richTierService.getCurrentTierForUser("u1");
    expect(out.tier).toBe(3);
  });

  it("processMonthlyRolloverForUser is no-op when history already exists", async () => {
    const txApi = {};
    $transaction.mockImplementation(
      async (fn: (tx: typeof txApi) => Promise<void>) => {
        historyExists.mockResolvedValueOnce(true);
        await fn(txApi);
      },
    );
    await richTierService.processMonthlyRolloverForUser("u1", 2026, 4);
    expect(upsertUserRichTier).not.toHaveBeenCalled();
    expect(insertHistory).not.toHaveBeenCalled();
  });

  it("processMonthlyRolloverForUser second run does not write again (idempotent)", async () => {
    const txMock = {
      userRichTier: { findUnique: vi.fn().mockResolvedValue(null) },
      monthlyRechargeAggregate: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    historyExists.mockResolvedValue(false);
    $transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<void>) => {
        await fn(txMock);
      },
    );
    await richTierService.processMonthlyRolloverForUser("u1", 2026, 1);
    historyExists.mockReset();
    historyExists.mockResolvedValue(true);
    await richTierService.processMonthlyRolloverForUser("u1", 2026, 1);
    expect(upsertUserRichTier).toHaveBeenCalledTimes(1);
  });

  it("processMonthlyRolloverForUser preserves live badge tier and applies carryover", async () => {
    const txMock = {
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "u1",
          currentTier: 6,
          carryoverCoins: 15_000_000n,
        }),
      },
      monthlyRechargeAggregate: {
        findUnique: vi.fn().mockResolvedValue({
          totalRechargeCoins: 35_000_000n,
        }),
      },
    };
    historyExists.mockResolvedValue(false);
    upsertUserRichTier.mockResolvedValue(undefined);
    insertHistory.mockResolvedValue(undefined);

    $transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<void>) => {
        await fn(txMock);
      },
    );

    await richTierService.processMonthlyRolloverForUser("u1", 2026, 5);

    expect(upsertUserRichTier).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        currentTier: 6,
        carryoverCoins: 10_000_000n,
      }),
      txMock,
    );
    expect(insertHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: 6,
        carryoverApplied: 10_000_000n,
      }),
      txMock,
    );
  });

  it("rollover with zero recharge yields tier 0 and carryover 0 when no carry-in", async () => {
    const txMock = {
      userRichTier: { findUnique: vi.fn().mockResolvedValue(null) },
      monthlyRechargeAggregate: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    historyExists.mockResolvedValue(false);
    $transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<void>) => {
        await fn(txMock);
      },
    );
    await richTierService.processMonthlyRolloverForUser("u1", 2026, 3);
    expect(upsertUserRichTier).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTier: 0,
        carryoverCoins: 0n,
      }),
      txMock,
    );
  });

  it("rollover downgrades badge when closed-month progress is insufficient", async () => {
    const txMock = {
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "u1",
          currentTier: 3,
          carryoverCoins: 1_500_000n,
        }),
      },
      monthlyRechargeAggregate: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    historyExists.mockResolvedValue(false);
    $transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<void>) => {
        await fn(txMock);
      },
    );
    await richTierService.processMonthlyRolloverForUser("u1", 2026, 4);
    expect(upsertUserRichTier).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTier: 0,
        carryoverCoins: 0n,
      }),
      txMock,
    );
  });

  it("rollover with tier-1 progress keeps tier 1 and zero carryover", async () => {
    const txMock = {
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "u1",
          currentTier: 1,
          carryoverCoins: 0n,
        }),
      },
      monthlyRechargeAggregate: {
        findUnique: vi.fn().mockResolvedValue({
          totalRechargeCoins: 3_000_000n,
        }),
      },
    };
    historyExists.mockResolvedValue(false);
    $transaction.mockImplementation(
      async (fn: (tx: typeof txMock) => Promise<void>) => {
        await fn(txMock);
      },
    );
    await richTierService.processMonthlyRolloverForUser("u1", 2026, 2);
    expect(upsertUserRichTier).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTier: 1,
        carryoverCoins: 0n,
      }),
      txMock,
    );
  });

  it("computeTier uses the default seed ladder", () => {
    expect(computeTier(0n)).toBe(0);
    expect(computeTier(RICH_TIER_THRESHOLDS[0]!)).toBe(1);
    expect(computeTier(RICH_TIER_THRESHOLDS[9]!)).toBe(10);
  });

  it("replaceTierConfig upserts 10 strictly increasing tiers and busts redis", async () => {
    const next = defaultRichTierLadder().map((r) => ({
      tier: r.tier,
      minRechargeCoins: (r.minRechargeCoins + 1n).toString(),
      displayName: r.displayName,
    }));
    replaceConfig.mockResolvedValue(undefined);
    getConfig.mockResolvedValue(
      next.map((r) => ({
        tier: r.tier,
        minRechargeCoins: BigInt(r.minRechargeCoins),
        displayName: r.displayName,
      })),
    );
    const out = await richTierService.replaceTierConfig(next);
    expect(replaceConfig).toHaveBeenCalled();
    expect(redisSet).toHaveBeenCalled();
    expect(out).toHaveLength(10);
    expect(out[0]?.minRechargeCoins).toBe((RICH_TIER_THRESHOLDS[0]! + 1n).toString());
  });

  it("replaceTierConfig rejects non-monotonic thresholds", async () => {
    const bad = defaultRichTierLadder().map((r) => ({
      tier: r.tier,
      minRechargeCoins: r.minRechargeCoins.toString(),
      displayName: r.displayName,
    }));
    bad[1]!.minRechargeCoins = "1000";
    await expect(richTierService.replaceTierConfig(bad)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(replaceConfig).not.toHaveBeenCalled();
  });
});
