import { describe, it, expect, vi, beforeEach } from "vitest";
const getMembershipState = vi.fn();
const updateMembershipState = vi.fn();
const insertPurchase = vi.fn();
const findPurchaseByLedgerEntryId = vi.fn();
const getLatestTier = vi.fn();
const getMembershipStateBulk = vi.fn();
const getDailyClaim = vi.fn();
const getLastDailyClaim = vi.fn();
const getRecentPurchases = vi.fn();
const insertDailyClaim = vi.fn();

vi.mock("../../src/repositories/vipMembership.repository", () => ({
  vipMembershipRepository: {
    getMembershipState: (...a: unknown[]) => getMembershipState(...a),
    updateMembershipState: (...a: unknown[]) => updateMembershipState(...a),
    insertPurchase: (...a: unknown[]) => insertPurchase(...a),
    findPurchaseByLedgerEntryId: (...a: unknown[]) =>
      findPurchaseByLedgerEntryId(...a),
    getLatestTier: (...a: unknown[]) => getLatestTier(...a),
    getMembershipStateBulk: (...a: unknown[]) => getMembershipStateBulk(...a),
    getDailyClaim: (...a: unknown[]) => getDailyClaim(...a),
    getLastDailyClaim: (...a: unknown[]) => getLastDailyClaim(...a),
    getRecentPurchases: (...a: unknown[]) => getRecentPurchases(...a),
    insertDailyClaim: (...a: unknown[]) => insertDailyClaim(...a),
  },
}));

const debit = vi.fn();
const credit = vi.fn();

vi.mock("../../src/services/coin-wallet.service", () => ({
  coinWalletService: {
    debit: (...a: unknown[]) => debit(...a),
    credit: (...a: unknown[]) => credit(...a),
  },
}));

const adjustCoinBalanceCache = vi.fn();
vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    adjustCoinBalanceCache: (...a: unknown[]) => adjustCoinBalanceCache(...a),
  },
}));

const refreshCacheLevel = vi.fn();
vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: {
    refreshCache: (...a: unknown[]) => refreshCacheLevel(...a),
  },
}));

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const cacheDelete = vi.fn();
vi.mock("../../src/services/cache.service", () => ({
  cacheService: {
    get: (...a: unknown[]) => cacheGet(...a),
    set: (...a: unknown[]) => cacheSet(...a),
    delete: (...a: unknown[]) => cacheDelete(...a),
  },
}));

const removeExpiry = vi.fn();
const enqueueExpiry = vi.fn();
vi.mock("../../src/queues/vip-membership.queue", () => ({
  removeVipMembershipExpiry: (...a: unknown[]) => removeExpiry(...a),
  enqueueVipMembershipExpiry: (...a: unknown[]) => enqueueExpiry(...a),
}));

const prismaUserFindUnique = vi.fn();
const prismaUserUpdate = vi.fn();
const prismaTx = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => prismaTx(fn),
    user: {
      findUnique: (...a: unknown[]) => prismaUserFindUnique(...a),
      update: (...a: unknown[]) => prismaUserUpdate(...a),
    },
    vipMembershipPurchase: { findMany: vi.fn() },
  },
  prismaRead: {
    vipMembershipPurchase: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { vipMembershipService } from "../../src/services/vip-membership.service";

describe("vipMembershipService.processExpiryJob", () => {
  beforeEach(() => {
    prismaUserFindUnique.mockReset();
    prismaUserUpdate.mockReset();
    cacheSet.mockReset();
    cacheGet.mockResolvedValue(null);
  });

  it("no-op when expiresAt still in the future", async () => {
    prismaUserFindUnique.mockResolvedValue({
      vipSubscriptionExpiresAt: new Date(Date.now() + 86_400_000),
    });
    await vipMembershipService.processExpiryJob({ userId: "u1" });
    expect(prismaUserUpdate).not.toHaveBeenCalled();
  });

  it("sets vipSubscriptionActive false when expired", async () => {
    prismaUserFindUnique.mockResolvedValue({
      vipSubscriptionExpiresAt: new Date(Date.now() - 86_400_000),
    });
    prismaUserUpdate.mockResolvedValue({} as never);
    getMembershipState.mockResolvedValue({
      isActive: false,
      expiresAt: new Date(Date.now() - 86_400_000),
    });
    getLatestTier.mockResolvedValue(null);

    await vipMembershipService.processExpiryJob({ userId: "u1" });
    expect(prismaUserUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { vipSubscriptionActive: false },
    });
  });
});

