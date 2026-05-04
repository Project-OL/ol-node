import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoinTxType, LedgerDirection, LevelType, WalletCurrencyType } from "@prisma/client";

const applyRecharge = vi.fn();
const refreshCacheAfterRecharge = vi.fn();
const wealthRefreshCache = vi.fn();

vi.mock("../../src/services/rich-tier.service", async () => {
  const { CoinTxType: CT } = await import("@prisma/client");
  return {
    RECHARGE_TX_TYPES: new Set([CT.TOPUP]),
    richTierService: {
      applyRecharge: (...a: unknown[]) => applyRecharge(...a),
      refreshCacheAfterRecharge: (...a: unknown[]) =>
        refreshCacheAfterRecharge(...a),
    },
  };
});

vi.mock("../../src/services/audit.service", () => ({
  auditService: { log: vi.fn() },
}));

vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: {
    applyCredit: vi.fn().mockResolvedValue({
      newCumulative: 100n,
      newLevel: 2,
      previousLevel: 1,
    }),
    refreshCache: (...a: unknown[]) => wealthRefreshCache(...a),
  },
}));

vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    getCachedIdemResponse: vi.fn().mockResolvedValue(null),
    acquireIdemKey: vi.fn().mockResolvedValue(true),
    adjustCoinBalanceCache: vi.fn().mockResolvedValue(undefined),
    resolveIdemKey: vi.fn().mockResolvedValue(undefined),
  },
}));

const lockForUpdate = vi.fn();
const bumpVersion = vi.fn();
vi.mock("../../src/repositories/wallet.repository", () => ({
  walletRepository: {
    getOrCreate: vi.fn().mockResolvedValue({ id: "wallet-1" }),
    lockForUpdate: (...a: unknown[]) => lockForUpdate(...a),
    bumpVersion: (...a: unknown[]) => bumpVersion(...a),
  },
}));

const insertLedger = vi.fn();
vi.mock("../../src/repositories/coin-ledger.repository", () => ({
  coinLedgerRepository: {
    insert: (...a: unknown[]) => insertLedger(...a),
  },
}));

const findFirstOrder = vi.fn();
const txFindFirst = vi.fn();
const txTopupUpdate = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    coinTopupOrder: {
      findFirst: (...a: unknown[]) => findFirstOrder(...a),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "../../src/config/database";
import { coinWalletService } from "../../src/services/coin-wallet.service";

describe("confirmTopup rich-tier wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirstOrder.mockResolvedValue({
      id: "ord-1",
      userId: "user-1",
      coins: 50,
      packageId: "pkg-1",
      status: "PENDING",
    });
    txFindFirst.mockResolvedValue(null);
    txTopupUpdate.mockResolvedValue({});
    insertLedger.mockResolvedValue({
      id: "ledger-1",
      balanceAfter: 50n,
    });
    applyRecharge.mockResolvedValue({ year: 2026, month: 5 });
    wealthRefreshCache.mockResolvedValue({
      currentLevel: 2,
      cumulativeTotal: "100",
      distanceToUpgrade: "0",
      leveledUp: true,
      previousLevel: 1,
      nextLevelThreshold: null,
      progressNumerator: "0",
      progressDenominator: null,
    });

    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          coinLedgerEntry: { findFirst: txFindFirst },
          coinTopupOrder: { update: txTopupUpdate },
        };
        return fn(tx);
      },
    );
  });

  it("calls applyRecharge inside $transaction before commit, then wealth refreshCache then refreshCacheAfterRecharge", async () => {
    const seq: string[] = [];
    applyRecharge.mockImplementation(async () => {
      seq.push("applyRecharge");
      return { year: 2026, month: 5 };
    });
    wealthRefreshCache.mockImplementation(async () => {
      seq.push("wealthRefresh");
      return {
        currentLevel: 2,
        cumulativeTotal: "100",
        distanceToUpgrade: "0",
        leveledUp: false,
        previousLevel: 1,
        nextLevelThreshold: null,
        progressNumerator: "0",
        progressDenominator: null,
      };
    });
    refreshCacheAfterRecharge.mockImplementation(async () => {
      seq.push("richRefresh");
    });

    await coinWalletService.confirmTopup(
      "user-1",
      "ord-1",
      "gw-1",
      "idem-1",
    );

    expect(insertLedger).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        txType: CoinTxType.TOPUP,
        direction: LedgerDirection.CREDIT,
      }),
    );
    expect(applyRecharge).toHaveBeenCalledWith(
      "user-1",
      50n,
      expect.anything(),
    );
    expect(seq).toEqual(["applyRecharge", "wealthRefresh", "richRefresh"]);
    expect(lockForUpdate).toHaveBeenCalled();
  });

  it("passes wallet getOrCreate with COIN currency", async () => {
    const { walletRepository } = await import(
      "../../src/repositories/wallet.repository"
    );
    await coinWalletService.confirmTopup("user-1", "ord-1", "gw-1", "idem-2");
    expect(walletRepository.getOrCreate).toHaveBeenCalledWith(
      "user-1",
      WalletCurrencyType.COIN,
    );
  });
});
