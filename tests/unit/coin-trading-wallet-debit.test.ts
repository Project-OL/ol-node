import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CoinTxType,
  WalletCurrencyType,
} from "@prisma/client";

/** Captures wallet.upsert currencyType from coinWalletService.debit/credit. */
const upsertCurrencyTypes: WalletCurrencyType[] = [];

vi.mock("../../src/config/redis", () => ({
  redisClient: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn(),
    del: vi.fn(),
  },
  RedisKeys: {
    ctBalance: (id: string) => `ct:balance:${id}`,
    ctRecentUsers: (id: string) => `ct:recent-users:${id}`,
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

vi.mock("../../src/repositories/wallet.repository", () => ({
  walletRepository: {
    getOrCreate: vi.fn(),
    lockForUpdate: vi.fn(),
    bumpVersion: vi.fn(),
  },
}));

vi.mock("../../src/repositories/coin-ledger.repository", () => ({
  coinLedgerRepository: {
    findByIdempotencyKey: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockImplementation(async (_tx, data) => ({
      id: "ledger-1",
      balanceAfter: data.balanceAfter,
    })),
    computeBalance: vi.fn().mockResolvedValue(0n),
  },
}));

vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: { applyCredit: vi.fn().mockResolvedValue(null) },
}));

vi.mock("../../src/repositories/coinTrading.repository", () => ({
  coinTradingRepository: {
    createTransfer: vi.fn().mockResolvedValue({ id: "transfer-1" }),
    getTopupRates: vi.fn(),
    getExchangeRates: vi.fn(),
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
    debit: vi.fn().mockResolvedValue({ ledgerEntryId: "pt-1" }),
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
        };
        return fn(tx);
      }),
      coinTradingTopupOrder: { create: vi.fn(), update: vi.fn() },
    },
    prismaRead: {},
  };
});

import { coinWalletService } from "../../src/services/coin-wallet.service";
import { coinTradingService } from "../../src/services/coinTrading.service";
import { userRepository } from "../../src/repositories/user.repository";
import { walletService } from "../../src/services/wallet.service";

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
    vi.spyOn(coinTradingService, "lookupExchangeRate").mockResolvedValue({
      usdEquiv: 1,
      coinsPerUsd: 9200,
      tradingCoinsAwarded: 9200n,
    });

    await coinTradingService.exchangePointsForTradingCoins("agent-1", 10_000n);

    expect(upsertCurrencyTypes).toContain(WalletCurrencyType.TRADING_COIN);
    expect(upsertCurrencyTypes).not.toContain(WalletCurrencyType.COIN);
    expect(walletService.adjustPointBalanceCache).toHaveBeenCalledWith(
      "agent-1",
      0n,
    );
    expect(walletService.adjustTradingBalanceCache).toHaveBeenCalledWith(
      "agent-1",
    );
  });
});
