import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoinTxType, LedgerDirection, Prisma, WalletCurrencyType } from "@prisma/client";

const applyRecharge = vi.fn();
const refreshCacheAfterRecharge = vi.fn();
const wealthGetSnapshot = vi.fn();

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
    applyCredit: vi.fn(),
    getSnapshot: (...a: unknown[]) => wealthGetSnapshot(...a),
  },
}));

const adjustCoinBalanceCache = vi.fn();
vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    getCachedIdemResponse: vi.fn().mockResolvedValue(null),
    acquireIdemKey: vi.fn().mockResolvedValue(true),
    adjustCoinBalanceCache: (...a: unknown[]) => adjustCoinBalanceCache(...a),
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

const findUniqueOrder = vi.fn();
const txFindFirst = vi.fn();
const txTopupUpdate = vi.fn();
const txTopupUpdateMany = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    coinTopupOrder: {
      findUnique: (...a: unknown[]) => findUniqueOrder(...a),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "../../src/config/database";
import { coinWalletService } from "../../src/services/coin-wallet.service";

const PAID = {
  epayOrderNo: "EP-1",
  epayStatus: "7",
  paidAmount: new Prisma.Decimal("2.99"),
  paidCurrency: "USD",
};

describe("creditPaidTopup (Epay-confirmed personal top-up)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueOrder.mockResolvedValue({
      id: "ord-1",
      userId: "user-1",
      coins: 50,
      packageId: "pkg-1",
      status: "PENDING",
      gatewayRef: null,
      merchantOrderNo: "CP261120ABCDEF0123456789",
    });
    txFindFirst.mockResolvedValue(null);
    txTopupUpdate.mockResolvedValue({});
    txTopupUpdateMany.mockResolvedValue({ count: 1 });
    insertLedger.mockResolvedValue({ id: "ledger-1", balanceAfter: 50n });
    applyRecharge.mockResolvedValue({ year: 2026, month: 5 });
    wealthGetSnapshot.mockResolvedValue({
      currentLevel: 2,
      cumulativeTotal: "100",
      distanceToUpgrade: "0",
      leveledUp: false,
      previousLevel: 2,
      nextLevelThreshold: null,
      progressNumerator: "0",
      progressDenominator: null,
    });

    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          coinLedgerEntry: { findFirst: txFindFirst },
          coinTopupOrder: { update: txTopupUpdate, updateMany: txTopupUpdateMany },
        };
        return fn(tx);
      },
    );
  });

  it("claims PENDING→PAID in the same tx, credits TOPUP with the epay ledger key, then rich tier", async () => {
    const seq: string[] = [];
    txTopupUpdateMany.mockImplementation(async () => {
      seq.push("claim");
      return { count: 1 };
    });
    insertLedger.mockImplementation(async () => {
      seq.push("ledger");
      return { id: "ledger-1", balanceAfter: 50n };
    });
    applyRecharge.mockImplementation(async () => {
      seq.push("applyRecharge");
      return { year: 2026, month: 5 };
    });
    refreshCacheAfterRecharge.mockImplementation(async () => {
      seq.push("richRefresh");
    });
    wealthGetSnapshot.mockImplementation(async () => {
      seq.push("wealthSnapshot");
      return {
        currentLevel: 2,
        cumulativeTotal: "100",
        distanceToUpgrade: "0",
        leveledUp: false,
        previousLevel: 2,
      };
    });

    const out = await coinWalletService.creditPaidTopup("ord-1", PAID);

    expect(txTopupUpdateMany).toHaveBeenCalledWith({
      where: { id: "ord-1", status: "PENDING" },
      data: expect.objectContaining({
        status: "PAID",
        gatewayRef: "EP-1",
        epayStatus: "7",
        paidCurrency: "USD",
      }),
    });
    expect(insertLedger).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        txType: CoinTxType.TOPUP,
        direction: LedgerDirection.CREDIT,
        amount: 50n,
        idempotencyKey: "epay-personal-topup:ord-1",
      }),
    );
    expect(applyRecharge).toHaveBeenCalledWith("user-1", 50n, expect.anything());
    expect(seq).toEqual(["claim", "ledger", "applyRecharge", "richRefresh", "wealthSnapshot"]);
    expect(lockForUpdate).toHaveBeenCalled();
    expect(adjustCoinBalanceCache).toHaveBeenCalledWith("user-1", 50n);
    expect(out).toMatchObject({ ledgerEntryId: "ledger-1", coins: 50 });
  });

  it("uses the COIN wallet", async () => {
    const { walletRepository } = await import("../../src/repositories/wallet.repository");
    await coinWalletService.creditPaidTopup("ord-1", PAID);
    expect(walletRepository.getOrCreate).toHaveBeenCalledWith("user-1", WalletCurrencyType.COIN);
  });

  it("a concurrent runner that loses the claim credits nothing", async () => {
    txTopupUpdateMany.mockResolvedValue({ count: 0 });
    const out = await coinWalletService.creditPaidTopup("ord-1", PAID);
    expect(out).toBeNull();
    expect(insertLedger).not.toHaveBeenCalled();
    expect(applyRecharge).not.toHaveBeenCalled();
    expect(adjustCoinBalanceCache).not.toHaveBeenCalled();
  });

  it("an order that is no longer PENDING is skipped without a transaction", async () => {
    findUniqueOrder.mockResolvedValue({ id: "ord-1", userId: "user-1", coins: 50, status: "PAID" });
    expect(await coinWalletService.creditPaidTopup("ord-1", PAID)).toBeNull();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
