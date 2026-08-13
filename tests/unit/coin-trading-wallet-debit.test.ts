import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CoinTxType,
  WalletCurrencyType,
} from "@prisma/client";

/** Captures wallet.upsert currencyType from coinWalletService.debit/credit. */
const upsertCurrencyTypes: WalletCurrencyType[] = [];

let exchangePointDebitKey = "";
let exchangeTradingCreditKey = "";

vi.mock("../../src/config/redis", () => ({
  redisClient: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    del: vi.fn(),
  },
  RedisKeys: {
    ctBalance: (id: string) => `ct:balance:${id}`,
    ctRecentUsers: (id: string) => `ct:recent-users:${id}`,
    ctPersonalExchangeRates: () => `ct:personal-exchange-rates`,
    walletCoinBalance: (id: string) => `wallet:coins:${id}`,
    walletPointBalance: (id: string) => `wallet:points:${id}`,
  },
  getRedisForRead: () => ({ get: vi.fn().mockResolvedValue(null) }),
  CT_BALANCE_TTL: 300,
  CT_RATES_TTL: 3600,
  CT_RECENT_USERS_TTL: 120,
}));

vi.mock("../../src/services/agency.service", () => ({
  agencyService: { enforcePauseGate: vi.fn() },
}));

vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    adjustCoinBalanceCache: vi.fn(),
    adjustPointBalanceCache: vi.fn(),
    adjustTradingBalanceCache: vi.fn(),
  },
}));

const lockForUpdateCalls: string[] = [];

vi.mock("../../src/repositories/wallet.repository", () => ({
  walletRepository: {
    // Distinct id per currency type — a shared id across currencies would
    // silently defeat lockWalletsInOrder's dedup-by-id logic in tests.
    getOrCreate: vi.fn().mockImplementation(
      (_userId: string, currencyType: WalletCurrencyType) => {
        const idByType: Record<string, string> = {
          [WalletCurrencyType.TRADING_COIN]: "wallet-trading",
          [WalletCurrencyType.COIN]: "wallet-coin",
          [WalletCurrencyType.POINT]: "wallet-point",
        };
        return { id: idByType[currencyType] ?? "wallet-coin", currencyType };
      },
    ),
    lockForUpdate: vi.fn().mockImplementation(async (_tx: unknown, walletId: string) => {
      lockForUpdateCalls.push(walletId);
      return null;
    }),
    bumpVersion: vi.fn(),
  },
}));

vi.mock("../../src/repositories/coin-ledger.repository", () => ({
  coinLedgerRepository: {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockImplementation(async (_tx, data: { idempotencyKey: string }) => {
      if (data.idempotencyKey.startsWith("exchange-ct:")) {
        exchangeTradingCreditKey = data.idempotencyKey;
      }
      return {
        id: "ledger-1",
        balanceAfter: data.balanceAfter,
      };
    }),
    computeBalance: vi.fn().mockResolvedValue(0n),
  },
}));

vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: {
    applyCredit: vi.fn().mockResolvedValue(null),
    invalidateCache: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/services/rich-tier.service", () => ({
  richTierService: {
    applyRecharge: vi.fn().mockResolvedValue({ year: 2026, month: 6 }),
    refreshCacheAfterRecharge: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/repositories/coinTrading.repository", () => ({
  coinTradingRepository: {
    createTransfer: vi.fn().mockResolvedValue({ id: "transfer-1" }),
    getTopupRates: vi.fn(),
    getExchangeRates: vi.fn(),
    getPersonalExchangeRates: vi.fn().mockResolvedValue([
      { minUsdEquiv: 0, maxUsdEquiv: null, coinsPerUsd: 9200 },
    ]),
  },
}));

vi.mock("../../src/repositories/user.repository", () => ({
  userRepository: {
    findById: vi.fn(),
    findByPublicId: vi.fn(),
  },
}));

vi.mock("../../src/services/point-wallet.service", () => ({
  pointWalletService: {
    debit: vi.fn().mockImplementation(
      async (
        _u,
        _a,
        _t,
        _tx,
        opts: { idempotencyKey: string },
      ) => {
        exchangePointDebitKey = opts.idempotencyKey;
        return { ledgerEntryId: "pt-1" };
      },
    ),
  },
}));

vi.mock("../../src/config/database", () => {
  const walletUpsert = vi.fn().mockImplementation(
    ({ where }: { where: { userId_currencyType: { currencyType: WalletCurrencyType } } }) => {
      const ct = where.userId_currencyType.currencyType;
      upsertCurrencyTypes.push(ct);
      return {
        id: ct === WalletCurrencyType.TRADING_COIN ? "wallet-trading" : "wallet-coin",
        currencyType: ct,
      };
    },
  );

  return {
    prisma: {
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          wallet: { upsert: walletUpsert },
          coinLedgerEntry: {
            findFirst: vi.fn().mockResolvedValue({ balanceAfter: 10_000n }),
          },
          // transferTradingCoins replays via the transfer row's unique key.
          coinTradingTransfer: {
            findUnique: vi.fn().mockResolvedValue(null),
          },
          user: {
            findUnique: vi.fn().mockResolvedValue({
              personalCoinsFrozen: false,
              tradingCoinsFrozen: false,
              pointsFrozen: false,
            }),
          },
        };
        return fn(tx);
      }),
      coinTradingTopupOrder: { create: vi.fn(), update: vi.fn() },
    },
    prismaRead: {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          personalCoinsFrozen: false,
          tradingCoinsFrozen: false,
        }),
      },
    },
  };
});

import { coinWalletService } from "../../src/services/coin-wallet.service";
import { coinTradingService } from "../../src/services/coinTrading.service";
import { userRepository } from "../../src/repositories/user.repository";
import { walletService } from "../../src/services/wallet.service";
import { coinTradingRepository } from "../../src/repositories/coinTrading.repository";

function makeTx() {
  return {
    wallet: {
      upsert: vi.fn().mockImplementation(
        ({ where }: { where: { userId_currencyType: { currencyType: WalletCurrencyType } } }) => ({
          id:
            where.userId_currencyType.currencyType === WalletCurrencyType.TRADING_COIN
              ? "w-trading"
              : "w-coin",
          currencyType: where.userId_currencyType.currencyType,
        }),
      ),
    },
    coinLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue({ balanceAfter: 5000n }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        personalCoinsFrozen: false,
        tradingCoinsFrozen: false,
        pointsFrozen: false,
      }),
    },
  };
}

describe("coinWalletService wallet selection", () => {
  beforeEach(() => {
    upsertCurrencyTypes.length = 0;
    vi.clearAllMocks();
  });

  it("debit() defaults to personal COIN wallet", async () => {
    const tx = makeTx();

    await coinWalletService.debit(
      "user-1",
      100n,
      CoinTxType.GIFT_SEND,
      tx as never,
      { idempotencyKey: "test-debit" },
    );

    expect(tx.wallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_currencyType: {
            userId: "user-1",
            currencyType: WalletCurrencyType.COIN,
          },
        },
      }),
    );
  });

  it("debit() with currencyType TRADING_COIN targets trading wallet", async () => {
    const tx = makeTx();

    await coinWalletService.debit(
      "user-1",
      100n,
      CoinTxType.TRADING_TRANSFER_OUT,
      tx as never,
      {
        idempotencyKey: "test-debit-trading",
        currencyType: WalletCurrencyType.TRADING_COIN,
      },
    );

    expect(tx.wallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_currencyType: {
            userId: "user-1",
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        },
      }),
    );
  });

  it("credit() defaults to personal COIN wallet", async () => {
    const tx = makeTx();

    await coinWalletService.credit(
      "user-2",
      100n,
      CoinTxType.TRADING_TRANSFER_IN,
      tx as never,
      { idempotencyKey: "test-credit", applyWealthCredit: false },
    );

    expect(tx.wallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_currencyType: {
            userId: "user-2",
            currencyType: WalletCurrencyType.COIN,
          },
        },
      }),
    );
  });

  it("credit() with currencyType TRADING_COIN targets trading wallet", async () => {
    const tx = makeTx();

    await coinWalletService.credit(
      "user-2",
      100n,
      CoinTxType.TRADING_EXCHANGE_FROM_POINTS,
      tx as never,
      {
        idempotencyKey: "test-credit-trading",
        applyWealthCredit: false,
        currencyType: WalletCurrencyType.TRADING_COIN,
      },
    );

    expect(tx.wallet.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_currencyType: {
            userId: "user-2",
            currencyType: WalletCurrencyType.TRADING_COIN,
          },
        },
      }),
    );
  });
});

describe("coinTradingService transfer/exchange wallet selection", () => {
  beforeEach(() => {
    upsertCurrencyTypes.length = 0;
    exchangePointDebitKey = "";
    exchangeTradingCreditKey = "";
    lockForUpdateCalls.length = 0;
    vi.clearAllMocks();
    vi.mocked(userRepository.findById).mockResolvedValue({
      id: "agent-1",
      isAgent: true,
    } as never);
    vi.mocked(userRepository.findByPublicId).mockResolvedValue({
      id: "recipient-1",
      isAgent: false,
      publicId: 999n,
    } as never);
  });

  it("transferTradingCoins debits sender TRADING_COIN and credits recipient COIN", async () => {
    await coinTradingService.transferTradingCoins("agent-1", {
      recipientPublicId: "999",
      tradingCoins: 500n,
      idempotencyKey: "idem-transfer-1",
    });

    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.TRADING_COIN);
    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.COIN);
    expect(
      upsertCurrencyTypes.filter((c) => c === WalletCurrencyType.TRADING_COIN),
    ).toHaveLength(1);
    expect(walletService.adjustTradingBalanceCache).toHaveBeenCalledWith("agent-1");
    expect(walletService.adjustCoinBalanceCache).toHaveBeenCalledWith(
      "recipient-1",
      0n,
    );
  });

  it("exchangePointsForTradingCoins credits TRADING_COIN not COIN", async () => {
    vi.mocked(coinTradingRepository.getExchangeRates).mockResolvedValue([
      { minUsdEquiv: 0, maxUsdEquiv: null, coinsPerUsd: 9200 },
    ] as never);

    await coinTradingService.exchangePointsForTradingCoins("agent-1", 20_000n);

    expect(exchangePointDebitKey).toMatch(/^exchange-pts:[0-9a-f-]{36}$/i);
    expect(exchangeTradingCreditKey).toBe(
      exchangePointDebitKey.replace(/^exchange-pts:/, "exchange-ct:"),
    );
    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.TRADING_COIN);
    expect(upsertCurrencyTypes).not.toContain(WalletCurrencyType.COIN);
    expect(walletService.adjustPointBalanceCache).toHaveBeenCalledWith(
      "agent-1",
      0n,
    );
    expect(walletService.adjustTradingBalanceCache).toHaveBeenCalledWith(
      "agent-1",
    );
    // Deterministic id-order locking (lockWalletsInOrder) up front, not
    // point-then-coin call order — proves the fix, not just the debit/credit
    // outcome. debit()/credit() each re-lock their own wallet internally
    // afterward (harmless no-op re-lock within the same tx), so only the
    // first two calls reflect lockWalletsInOrder's ordering.
    expect(lockForUpdateCalls.slice(0, 2)).toEqual(["wallet-point", "wallet-trading"]);
  });

  it("exchange (non-agent, personal COIN) locks wallets in id order — the case that actually distinguishes the fix, since wallet-coin < wallet-point lexically (opposite of debit/credit call order)", async () => {
    vi.mocked(userRepository.findById).mockResolvedValue({
      id: "user-1",
      isAgent: false,
    } as never);

    await coinTradingService.exchangePointsForTradingCoins("user-1", 20_000n);

    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.COIN);
    expect(upsertCurrencyTypes).not.toContain(WalletCurrencyType.TRADING_COIN);
    // Old (buggy) call-order would have been ["wallet-point", "wallet-coin"]
    // (debit POINT, then credit COIN). Id-sorted order is the opposite.
    expect(lockForUpdateCalls.slice(0, 2)).toEqual(["wallet-coin", "wallet-point"]);
  });

  it("exchangePointsForTradingCoins rejects non-multiple of 10,000 points", async () => {
    await expect(
      coinTradingService.exchangePointsForTradingCoins("agent-1", 10_100n),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT_STEP" });
  });

  it("transferTradingCoins rejects non-multiple of 100 trading coins", async () => {
    await expect(
      coinTradingService.transferTradingCoins("agent-1", {
        recipientPublicId: "999",
        tradingCoins: 150n,
        idempotencyKey: "idem-bad-step",
      }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT_STEP" });
  });

  it("transferTradingCoins allows self-transfer to personal coin wallet", async () => {
    vi.mocked(userRepository.findByPublicId).mockResolvedValue({
      id: "agent-1",
      isAgent: true,
      publicId: 12345n,
    } as never);

    await coinTradingService.transferTradingCoins("agent-1", {
      recipientPublicId: "12345",
      tradingCoins: 500n,
      targetWalletType: "PERSONAL",
      idempotencyKey: "idem-self-personal",
    });

    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.TRADING_COIN);
    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.COIN);
    expect(walletService.adjustTradingBalanceCache).toHaveBeenCalledWith("agent-1");
    expect(walletService.adjustCoinBalanceCache).toHaveBeenCalledWith("agent-1", 0n);
    expect(coinTradingRepository.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAgentUserId: "agent-1",
        recipientUserId: "agent-1",
        recipientWalletType: "PERSONAL",
      }),
      expect.anything(),
    );
  });

  it("transferTradingCoins rejects self-transfer without PERSONAL target", async () => {
    vi.mocked(userRepository.findByPublicId).mockResolvedValue({
      id: "agent-1",
      isAgent: true,
      publicId: 12345n,
    } as never);

    await expect(
      coinTradingService.transferTradingCoins("agent-1", {
        recipientPublicId: "12345",
        tradingCoins: 500n,
        idempotencyKey: "idem-self-trading",
      }),
    ).rejects.toMatchObject({ code: "SELF_TRANSFER" });
  });
});
