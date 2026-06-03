import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LedgerDirection,
  PointTxType,
  WalletCurrencyType,
} from "@prisma/client";

const getOrCreate = vi.fn();
vi.mock("../../src/repositories/wallet.repository", () => ({
  walletRepository: {
    getOrCreate: (...a: unknown[]) => getOrCreate(...a),
  },
}));

const findByIdForWallet = vi.fn();
vi.mock("../../src/repositories/point-ledger.repository", () => ({
  pointLedgerRepository: {
    findByIdForWallet: (...a: unknown[]) => findByIdForWallet(...a),
  },
}));

const userFindMany = vi.fn();
vi.mock("../../src/config/database", () => ({
  prisma: {},
  prismaRead: {
    user: {
      findMany: (...a: unknown[]) => userFindMany(...a),
    },
  },
}));

vi.mock("../../src/services/wallet.service", () => ({
  walletService: {},
}));
vi.mock("../../src/services/audit.service", () => ({
  auditService: { log: vi.fn() },
}));
vi.mock("../../src/services/user-level.service", () => ({
  walletLevelService: {},
}));
vi.mock("../../src/services/withdrawal.service", () => ({
  withdrawalService: {},
}));

import { pointWalletService } from "../../src/services/point-wallet.service";

const WALLET_ID = "wallet-1";
const USER_ID = "user-self";
const OTHER_ID = "user-other";
const ENTRY_ID = "entry-1";

beforeEach(() => {
  vi.clearAllMocks();
  getOrCreate.mockResolvedValue({ id: WALLET_ID, userId: USER_ID });
});

describe("pointWalletService.getTransactionDetail", () => {
  it("returns 404 when entry is not in caller wallet", async () => {
    findByIdForWallet.mockResolvedValue(null);
    await expect(
      pointWalletService.getTransactionDetail(USER_ID, ENTRY_ID),
    ).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
  });

  it("returns entry with self and counterparty profiles", async () => {
    findByIdForWallet.mockResolvedValue({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      direction: LedgerDirection.CREDIT,
      txType: PointTxType.GIFT_RECEIVE,
      amount: 60_000n,
      balanceAfter: 160_000n,
      refId: "gift-tx-1",
      counterpartyId: OTHER_ID,
      description: "Gift received",
      metadata: { giftId: "g1" },
      idempotencyKey: "idem-1",
      createdAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    userFindMany.mockResolvedValue([
      {
        id: USER_ID,
        username: "host1",
        firstName: "Host",
        lastName: "One",
        avatarUrl: "https://cdn/self.png",
      },
      {
        id: OTHER_ID,
        username: "fan1",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
    ]);

    const out = await pointWalletService.getTransactionDetail(USER_ID, ENTRY_ID);

    expect(getOrCreate).toHaveBeenCalledWith(USER_ID, WalletCurrencyType.POINT);
    expect(findByIdForWallet).toHaveBeenCalledWith(ENTRY_ID, WALLET_ID);
    expect(out.id).toBe(ENTRY_ID);
    expect(out.amount).toBe("60000");
    expect(out.refId).toBe("gift-tx-1");
    expect(out.transactionDateTime).toBe("2026-06-01T12:00:00.000Z");
    expect(out.createdAt).toBe(out.transactionDateTime);
    expect(out.earningsCategory).toBe("livestream");
    expect(out.self).toEqual({
      userId: USER_ID,
      username: "host1",
      displayName: "Host One",
      avatarUrl: "https://cdn/self.png",
    });
    expect(out.counterparty).toEqual({
      userId: OTHER_ID,
      username: "fan1",
      displayName: "fan1",
      avatarUrl: null,
    });
  });

  it("returns null counterparty when not set", async () => {
    findByIdForWallet.mockResolvedValue({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      direction: LedgerDirection.DEBIT,
      txType: PointTxType.WITHDRAWAL_ESCROW,
      amount: 10_000n,
      balanceAfter: 50_000n,
      refId: "wd-1",
      counterpartyId: null,
      description: null,
      metadata: null,
      idempotencyKey: "idem-2",
      createdAt: new Date(),
    });
    userFindMany.mockResolvedValue([
      {
        id: USER_ID,
        username: "host1",
        firstName: null,
        lastName: null,
        avatarUrl: null,
      },
    ]);

    const out = await pointWalletService.getTransactionDetail(USER_ID, ENTRY_ID);
    expect(out.counterparty).toBeNull();
    expect(out.earningsCategory).toBeNull();
  });
});
