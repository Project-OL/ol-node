import { describe, it, expect, vi, beforeEach } from "vitest";

const adjustCoinBalanceCache = vi.fn();
const adjustPointBalanceCache = vi.fn();
const getCoinBalance = vi.fn();
const refreshCache = vi.fn();

vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    adjustCoinBalanceCache: (...a: unknown[]) => adjustCoinBalanceCache(...a),
    adjustPointBalanceCache: (...a: unknown[]) => adjustPointBalanceCache(...a),
    getCoinBalance: (...a: unknown[]) => getCoinBalance(...a),
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

vi.mock("../../src/config/redis", () => ({
  redisClient: { del: (...a: unknown[]) => redisDel(...a) },
  getRedisForRead: () => ({ get: vi.fn() }),
  RedisKeys: {
    walletCoinBalance: (u: string) => `wallet:coins:${u}`,
    walletPointBalance: (u: string) => `wallet:points:${u}`,
    fanRanking: (h: string, p: string, k: string) =>
      `fanrank:${h}:${p}:${k}`,
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

vi.mock("../../src/config/database", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => $transaction(...a),
  },
}));

vi.mock("../../src/config/env", () => ({
  env: { GIFT_COIN_TO_POINT_RATE: 1 },
}));

import { giftTransactionService } from "../../src/services/gift-transaction.service";

function mockTx() {
  return {
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
    expect(result.pointsAwarded).toBe(500);
    expect(result.galleryUpdated).toBe(true);
    expect(result.galleryNowFull).toBe(true);
    expect(coinInsert).toHaveBeenCalled();
    expect(pointInsert).toHaveBeenCalled();
    expect(recordGiftProgress).toHaveBeenCalledWith({
      hostUserId: "r1",
      giftId: "g1",
      senderId: "s1",
    });
    expect(adjustCoinBalanceCache).toHaveBeenCalledWith("s1", 0n);
    expect(adjustPointBalanceCache).toHaveBeenCalledWith("r1", 0n);
    expect(refreshCache).toHaveBeenCalled();
    expect(redisDel).toHaveBeenCalled();
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
