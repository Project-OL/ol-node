import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { CoinTxType } from "@prisma/client";
import { RECHARGE_TX_TYPES } from "../../src/services/rich-tier.service";

const historyExists = vi.fn();
const upsertUserRichTier = vi.fn();
const upsertMonthlyAggregate = vi.fn();
const insertHistory = vi.fn();
const getUserRichTier = vi.fn();
const getMonthlyAggregate = vi.fn();
const getConfig = vi.fn();
const listHistory = vi.fn();

vi.mock("../../src/repositories/richTier.repository", () => ({
  richTierRepository: {
    upsertMonthlyAggregate: (...a: unknown[]) => upsertMonthlyAggregate(...a),
    getMonthlyAggregate: (...a: unknown[]) => getMonthlyAggregate(...a),
    getUserRichTier: (...a: unknown[]) => getUserRichTier(...a),
    upsertUserRichTier: (...a: unknown[]) => upsertUserRichTier(...a),
    insertHistory: (...a: unknown[]) => insertHistory(...a),
    historyExists: (...a: unknown[]) => historyExists(...a),
    listHistory: (...a: unknown[]) => listHistory(...a),
    getConfig: (...a: unknown[]) => getConfig(...a),
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
const userRichTierUpsert = vi.fn();
const userRichTierUpdate = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => $transaction(...a),
    userRichTier: {
      upsert: (...a: unknown[]) => userRichTierUpsert(...a),
      update: (...a: unknown[]) => userRichTierUpdate(...a),
    },
  },
  prismaRead: {},
}));

import { richTierService } from "../../src/services/rich-tier.service";

describe("richTierService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisGet.mockResolvedValue(null);
    getConfig.mockResolvedValue([
      { tier: 1, minRechargeCoins: 3_000_000n, displayName: "RICH I" },
      { tier: 2, minRechargeCoins: 5_000_000n, displayName: "RICH II" },
    ]);
    findMostRecent.mockResolvedValue(null);
  });

  it("RECHARGE_TX_TYPES only contains TOPUP", () => {
    expect(RECHARGE_TX_TYPES.has(CoinTxType.TOPUP)).toBe(true);
    expect(RECHARGE_TX_TYPES.size).toBe(1);
  });

  it("getCurrentTierForUser sets badgeVisible false when not VIP", async () => {
    getUserRichTier.mockResolvedValue(null);
    getMonthlyAggregate.mockResolvedValue(null);
    const out = await richTierService.getCurrentTierForUser("u1");
    expect(out.badgeVisible).toBe(false);
    expect(out.tier).toBe(0);
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
    expect(out.badgeVisible).toBe(true);
  });

  it("applyRecharge only upserts monthly aggregate and never writes user_rich_tier", async () => {
    const tx = {} as Prisma.TransactionClient;
    upsertMonthlyAggregate.mockResolvedValue(undefined);
    await richTierService.applyRecharge("u1", 1000n, tx);
    expect(upsertMonthlyAggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        deltaCoins: 1000n,
      }),
      tx,
    );
    expect(upsertUserRichTier).not.toHaveBeenCalled();
    expect(userRichTierUpsert).not.toHaveBeenCalled();
    expect(userRichTierUpdate).not.toHaveBeenCalled();
  });

  it("getCurrentTierForUser returns user_rich_tier.currentTier for badge, not live-computed tier", async () => {
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

  it("processMonthlyRolloverForUser applies carryover + pure recharges (Rich VIII carryover + new → tier 6)", async () => {
    const txMock = {
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "u1",
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

  it("tier-1 user with no recharge rolls to tier 0 with carryover 0", async () => {
    const txMock = {
      userRichTier: {
        findUnique: vi.fn().mockResolvedValue({
          userId: "u1",
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
});
