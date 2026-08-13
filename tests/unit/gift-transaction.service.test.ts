import { describe, it, expect, vi, beforeEach } from "vitest";

const adjustCoinBalanceCache = vi.fn();
const adjustPointBalanceCache = vi.fn();
const getCoinBalance = vi.fn();
const refreshCache = vi.fn();
const writeCoinBalanceCache = vi.fn();
const writePointBalanceCache = vi.fn();
const getCachedIdemResponse = vi.fn();
const acquireIdemKey = vi.fn();
const resolveIdemKey = vi.fn();

vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    adjustCoinBalanceCache: (...a: unknown[]) => adjustCoinBalanceCache(...a),
    adjustPointBalanceCache: (...a: unknown[]) => adjustPointBalanceCache(...a),
    getCoinBalance: (...a: unknown[]) => getCoinBalance(...a),
    writeCoinBalanceCache: (...a: unknown[]) => writeCoinBalanceCache(...a),
    writePointBalanceCache: (...a: unknown[]) => writePointBalanceCache(...a),
    getCachedIdemResponse: (...a: unknown[]) => getCachedIdemResponse(...a),
    acquireIdemKey: (...a: unknown[]) => acquireIdemKey(...a),
    resolveIdemKey: (...a: unknown[]) => resolveIdemKey(...a),
  },
}));

const applyCredit = vi.fn();

vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: {
    applyCredit: (...a: unknown[]) => applyCredit(...a),
    refreshCache: (...a: unknown[]) => refreshCache(...a),
  },
}));

const recordGiftProgress = vi.fn();

vi.mock("../../src/services/gift-gallery.service", () => ({
  giftGalleryService: {
    recordGiftProgress: (...a: unknown[]) => recordGiftProgress(...a),
  },
}));

const redisDel = vi.fn();

vi.mock("../../src/services/vip-membership.service", () => ({
  vipMembershipService: {
    hasActive: vi.fn().mockResolvedValue(false),
  },
}));

vi.mock("../../src/utils/block-relationship", () => ({
  assertNotBlockedEitherWay: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config/redis", () => ({
  redisClient: {
    del: (...a: unknown[]) => redisDel(...a),
    pipeline: () => {
      const pipe = {
        del: (...a: unknown[]) => {
          redisDel(...a);
          return pipe;
        },
        exec: vi.fn().mockResolvedValue([]),
      };
      return pipe;
    },
  },
  getRedisForRead: () => ({ get: vi.fn() }),
  RedisKeys: {
    walletCoinBalance: (u: string) => `wallet:coins:${u}`,
    walletPointBalance: (u: string) => `wallet:points:${u}`,
    fanRanking: (h: string, p: string, k: string) =>
      `fanrank:${h}:${p}:${k}`,
    vipmActive: (u: string) => `vipm:active:${u}`,
    hostRevenueShares: () => `host-revenue-shares`,
  },
  GIFT_LIST_CACHE_TTL: 600,
  GALLERY_HOST_TTL: 300,
  GALLERY_TEMPLATE_TTL: 600,
  GIFT_GALLERY_CACHE_TTL: 300,
  FAN_RANK_DAY_TTL: 120,
  FAN_RANK_WEEK_MONTH_TTL: 300,
}));

const findById = vi.fn();
vi.mock("../../src/repositories/gift.repository", () => ({
  giftRepository: {
    findById: (...a: unknown[]) => findById(...a),
  },
}));

const getOrCreate = vi.fn();
const lockForUpdate = vi.fn();
const bumpVersion = vi.fn();

vi.mock("../../src/repositories/wallet.repository", () => ({
  walletRepository: {
    getOrCreate: (...a: unknown[]) => getOrCreate(...a),
    lockForUpdate: (...a: unknown[]) => lockForUpdate(...a),
    bumpVersion: (...a: unknown[]) => bumpVersion(...a),
  },
}));

const coinInsert = vi.fn();
const pointInsert = vi.fn();

vi.mock("../../src/repositories/coin-ledger.repository", () => ({
  coinLedgerRepository: {
    insert: (...a: unknown[]) => coinInsert(...a),
  },
}));

vi.mock("../../src/repositories/point-ledger.repository", () => ({
  pointLedgerRepository: {
    insert: (...a: unknown[]) => pointInsert(...a),
  },
}));

const giftTxCreate = vi.fn();
vi.mock("../../src/repositories/gift-transaction.repository", () => ({
  giftTransactionRepository: {
    create: (...a: unknown[]) => giftTxCreate(...a),
  },
}));

const $transaction = vi.fn();
const prismaReadUserFindUnique = vi.fn().mockResolvedValue({
  personalCoinsFrozen: false,
  tradingCoinsFrozen: false,
  pointsFrozen: false,
});

const fanSpendUpsert = vi.fn().mockResolvedValue({});

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => $transaction(...a),
    fanSpend: {
      upsert: (...a: unknown[]) => fanSpendUpsert(...a),
    },
  },
  prismaRead: {
    user: {
      findUnique: (...a: unknown[]) => prismaReadUserFindUnique(...a),
    },
  },
}));


vi.mock("../../src/services/agencyCommission.service", () => ({
  agencyCommissionService: {
    applyCommission: vi.fn().mockResolvedValue({ bustAgentUserId: null }),
    bustAgentCommissionCaches: vi.fn().mockResolvedValue(undefined),
  },
}));

import { giftTransactionService } from "../../src/services/gift-transaction.service";
import { giftSendMetrics } from "../../src/services/giftSend.metrics";
import { rootLogger } from "../../src/utils/rootLogger";

function mockTx() {
  return {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        personalCoinsFrozen: false,
        tradingCoinsFrozen: false,
        pointsFrozen: false,
      }),
    },
    coinLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue({ balanceAfter: 5000n }),
    },
    pointLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue({ balanceAfter: 0n }),
    },
    fanSpend: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCachedIdemResponse.mockResolvedValue(null);
  acquireIdemKey.mockResolvedValue(true);
  resolveIdemKey.mockResolvedValue(undefined);
  pointInsert.mockResolvedValue({
    id: "pt-entry-1",
    balanceAfter: 500n,
  });
  getOrCreate
    .mockResolvedValueOnce({ id: "w-coin", userId: "s1" })
    .mockResolvedValueOnce({ id: "w-point", userId: "r1" });
  applyCredit.mockResolvedValue({
    newLevel: 2,
    previousLevel: 1,
    newCumulative: 100n,
  });
  giftTxCreate.mockResolvedValue({ id: "gt-1" });
  getCoinBalance.mockResolvedValue(4500n);
  recordGiftProgress.mockResolvedValue({
    created: true,
    galleryNowFull: true,
  });
});

describe("giftTransactionService.sendGift", () => {
  it("rejects self-send", async () => {
    await expect(
      giftTransactionService.sendGift({
        senderUserId: "u1",
        receiverUserId: "u1",
        giftId: "g1",
        context: "direct",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("throws 404 when gift missing or inactive", async () => {
    findById.mockResolvedValue(null);
    await expect(
      giftTransactionService.sendGift({
        senderUserId: "s1",
        receiverUserId: "r1",
        giftId: "g1",
        context: "direct",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("rolls back when coin balance insufficient", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 9999,
      isActive: true,
      tags: [],
    });
    const tx = mockTx();
    (tx.coinLedgerEntry.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      balanceAfter: 100n,
    });
    $transaction.mockImplementation((fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    );
    await expect(
      giftTransactionService.sendGift({
        senderUserId: "s1",
        receiverUserId: "r1",
        giftId: "g1",
        context: "direct",
      }),
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(giftTxCreate).not.toHaveBeenCalled();
    expect(recordGiftProgress).not.toHaveBeenCalled();
  });

  it("happy path: debit, credit, fan spend, recordGiftProgress after commit", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 500,
      isActive: true,
      tags: [],
    });
    const tx = mockTx();
    $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    );
    const result = await giftTransactionService.sendGift({
      senderUserId: "s1",
      receiverUserId: "r1",
      giftId: "g1",
      context: "direct",
    });
    expect(result.transactionId).toBe("gt-1");
    expect(result.coinCost).toBe(500);
    expect(result.pointsAwarded).toBe(300);
    expect(result.galleryUpdated).toBe(true);
    expect(result.galleryNowFull).toBe(true);
    expect(coinInsert).toHaveBeenCalled();
    expect(pointInsert).toHaveBeenCalled();
    expect(recordGiftProgress).toHaveBeenCalledWith({
      hostUserId: "r1",
      giftId: "g1",
      senderId: "s1",
    });
    expect(writeCoinBalanceCache).toHaveBeenCalledWith("s1", 4500n);
    expect(writePointBalanceCache).toHaveBeenCalledWith("r1", 300n);
    expect(refreshCache).toHaveBeenCalled();
    expect(redisDel).toHaveBeenCalled();
  });

  it("missing idempotencyKey: bumps the metric and logs a warning (Phase 3c step 1 — observability only, still no replay protection)", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 500,
      isActive: true,
      tags: [],
    });
    const tx = mockTx();
    $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const warnSpy = vi.spyOn(rootLogger, "warn").mockImplementation(() => rootLogger);
    const before = giftSendMetrics.missingIdempotencyKeyCount;

    await giftTransactionService.sendGift({
      senderUserId: "s1",
      receiverUserId: "r1",
      giftId: "g1",
      context: "direct",
    });

    expect(giftSendMetrics.missingIdempotencyKeyCount).toBe(before + 1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ senderUserId: "s1", giftId: "g1" }),
      expect.stringContaining("missing idempotencyKey"),
    );
    warnSpy.mockRestore();
  });

  it("present idempotencyKey: does not bump the missing-key metric", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 500,
      isActive: true,
      tags: [],
    });
    const tx = mockTx();
    $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const before = giftSendMetrics.missingIdempotencyKeyCount;

    await giftTransactionService.sendGift({
      senderUserId: "s1",
      receiverUserId: "r1",
      giftId: "g1",
      context: "direct",
      idempotencyKey: "client-key-12345",
    });

    expect(giftSendMetrics.missingIdempotencyKeyCount).toBe(before);
  });

  it("idempotent retry with the same key returns the cached original result without re-executing (no second charge)", async () => {
    const cached = { transactionId: "gt-1", coinCost: 500, pointsAwarded: 300 };
    getCachedIdemResponse.mockResolvedValue(cached);

    const result = await giftTransactionService.sendGift({
      senderUserId: "s1",
      receiverUserId: "r1",
      giftId: "g1",
      context: "direct",
      idempotencyKey: "client-key-12345",
    });

    expect(result).toBe(cached);
    expect($transaction).not.toHaveBeenCalled();
    expect(coinInsert).not.toHaveBeenCalled();
  });

  it("concurrent double-submit with the same key: the loser gets IDEM_CONFLICT before ever charging", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 500,
      isActive: true,
      tags: [],
    });
    const tx = mockTx();
    $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    // First caller wins the Redis NX lock; the concurrent second caller's
    // acquireIdemKey sees it already held.
    acquireIdemKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const params = {
      senderUserId: "s1",
      receiverUserId: "r1",
      giftId: "g1",
      context: "direct" as const,
      idempotencyKey: "client-key-12345",
    };
    const [winner, loser] = await Promise.allSettled([
      giftTransactionService.sendGift(params),
      giftTransactionService.sendGift(params),
    ]);

    expect(winner.status).toBe("fulfilled");
    expect(loser.status).toBe("rejected");
    if (loser.status === "rejected") {
      expect(loser.reason).toMatchObject({ statusCode: 409, code: "IDEM_CONFLICT" });
    }
    // Exactly one charge — the loser never reached executeSendGift's ledger insert.
    expect(coinInsert).toHaveBeenCalledTimes(1);
  });

  it("maps recordGiftProgress created=false to galleryUpdated false", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 100,
      isActive: true,
      tags: [],
    });
    recordGiftProgress.mockResolvedValueOnce({
      created: false,
      galleryNowFull: false,
    });
    const tx = mockTx();
    $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    );
    const result = await giftTransactionService.sendGift({
      senderUserId: "s1",
      receiverUserId: "r1",
      giftId: "g1",
      context: "livestream",
    });
    expect(result.galleryUpdated).toBe(false);
    expect(result.galleryNowFull).toBe(false);
    expect(recordGiftProgress).toHaveBeenCalled();
  });

  it("does not fail send when recordGiftProgress throws", async () => {
    findById.mockResolvedValue({
      id: "g1",
      name: "Rose",
      coinCost: 10,
      isActive: true,
      tags: [],
    });
    recordGiftProgress.mockRejectedValueOnce(new Error("redis down"));
    const tx = mockTx();
    $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) =>
      fn(tx),
    );
    const result = await giftTransactionService.sendGift({
      senderUserId: "s2",
      receiverUserId: "r1",
      giftId: "g1",
      context: "direct",
    });
    expect(result.transactionId).toBe("gt-1");
    expect(result.galleryUpdated).toBe(false);
    expect(result.galleryNowFull).toBe(false);
  });
});
