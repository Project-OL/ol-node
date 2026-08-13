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
const findByRefForWallet = vi.fn();
vi.mock("../../src/repositories/point-ledger.repository", () => ({
  pointLedgerRepository: {
    findByIdForWallet: (...a: unknown[]) => findByIdForWallet(...a),
    findByRefForWallet: (...a: unknown[]) => findByRefForWallet(...a),
  },
}));

const userFindMany = vi.fn();
const payrollConfigFindUnique = vi.fn();
const withdrawalFindUnique = vi.fn();
vi.mock("../../src/config/database", () => ({
  prisma: {},
  prismaRead: {
    user: {
      findMany: (...a: unknown[]) => userFindMany(...a),
    },
    payrollConfig: {
      findUnique: (...a: unknown[]) => payrollConfigFindUnique(...a),
    },
    withdrawal: {
      findUnique: (...a: unknown[]) => withdrawalFindUnique(...a),
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
  payrollConfigFindUnique.mockResolvedValue({ inrPerUsd: { toString: () => "86" } });
  withdrawalFindUnique.mockResolvedValue(null);
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
        publicId: 111n,
      },
      {
        id: OTHER_ID,
        username: "fan1",
        firstName: null,
        lastName: null,
        avatarUrl: null,
        publicId: 222n,
      },
    ]);

    const out = await pointWalletService.getTransactionDetail(USER_ID, ENTRY_ID);

    expect(getOrCreate).toHaveBeenCalledWith(USER_ID, WalletCurrencyType.POINT);
    expect(findByIdForWallet).toHaveBeenCalledWith(ENTRY_ID, WALLET_ID);
    expect(out.id).toBe(ENTRY_ID);
    expect(out.amount).toBe("60000");
    expect(out.refId).toBe("gift-tx-1");
    expect(out.refIdEntityType).toBe("gift_transaction");
    expect(out.amountDetails).toMatchObject({
      points: "60000",
      usdAmount: "6.00",
      pointsPerUsd: 10_000,
      conversionLabel: "$6.00 = 60,000 points",
      actualAmountReceivedUsd: "6.00",
      localCurrency: { code: "INR", amount: "516.00", usdBasis: "6.00" },
    });
    expect(out.transactionDateTime).toBe("2026-06-01T12:00:00.000Z");
    expect(out.createdAt).toBe(out.transactionDateTime);
    expect(out.earningsCategory).toBe("livestream");
    expect(out.self).toEqual({
      userId: USER_ID,
      username: "host1",
      name: "Host One",
      displayName: "Host One",
      publicId: "111",
      avatarUrl: "https://cdn/self.png",
    });
    expect(out.counterparty).toEqual({
      userId: OTHER_ID,
      username: 'fan1',
      // formatUserName: trimmed firstName+lastName, no username fallback (2026-08-12) —
      // this counterparty has no first/last name, so name is empty while displayName
      // still falls back to username.
      name: '',
      displayName: 'fan1',
      publicId: '222',
      avatarUrl: null,
    });
    expect(out.transactionName).toBe('Gift received');
    expect(out.counterpartyDetails).toMatchObject({
      userId: OTHER_ID,
      name: '',
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
        publicId: 111n,
      },
    ]);

    const out = await pointWalletService.getTransactionDetail(USER_ID, ENTRY_ID);
    expect(out.counterparty).toBeNull();
    expect(out.earningsCategory).toBeNull();
  });

  it("resolves refId from metadata.transferId when column is null", async () => {
    findByIdForWallet.mockResolvedValue({
      id: ENTRY_ID,
      walletId: WALLET_ID,
      direction: LedgerDirection.CREDIT,
      txType: PointTxType.AGENT_POINT_TRANSFER,
      amount: 100_000n,
      balanceAfter: 200_000n,
      refId: null,
      counterpartyId: OTHER_ID,
      description: null,
      metadata: { transferId: "transfer-abc" },
      idempotencyKey: "idem-3",
      createdAt: new Date("2026-06-01T12:00:00.000Z"),
    });
    userFindMany.mockResolvedValue([
      {
        id: USER_ID,
        username: "agent1",
        firstName: null,
        lastName: null,
        avatarUrl: null,
        publicId: 111n,
      },
      {
        id: OTHER_ID,
        username: "agent2",
        firstName: null,
        lastName: null,
        avatarUrl: null,
        publicId: 333n,
      },
    ]);

    const out = await pointWalletService.getTransactionDetail(USER_ID, ENTRY_ID);
    expect(out.refId).toBe("transfer-abc");
    expect(out.amountDetails.usdAmount).toBe("10.00");
  });
});

describe("pointWalletService.getTransactionsByRefId", () => {
  it("returns all wallet rows for a business refId", async () => {
    findByRefForWallet.mockResolvedValue([
      {
        id: "entry-escrow",
        walletId: WALLET_ID,
        direction: LedgerDirection.DEBIT,
        txType: PointTxType.WITHDRAWAL_ESCROW,
        amount: 100_000n,
        balanceAfter: 0n,
        refId: "wd-1",
        counterpartyId: null,
        description: null,
        metadata: null,
        idempotencyKey: "idem-wd",
        createdAt: new Date("2026-06-01T10:00:00.000Z"),
      },
    ]);
    userFindMany.mockResolvedValue([
      {
        id: USER_ID,
        username: "host1",
        firstName: null,
        lastName: null,
        avatarUrl: null,
        publicId: 111n,
      },
    ]);
    withdrawalFindUnique.mockResolvedValue({
      amountPoints: 100_000n,
      hostPayoutUsd: { toString: () => "9.40" },
      platformFeePoints: 6_000n,
    });

    const out = await pointWalletService.getTransactionsByRefId(USER_ID, "wd-1");

    expect(findByRefForWallet).toHaveBeenCalledWith(WALLET_ID, "wd-1");
    expect(out.refId).toBe("wd-1");
    expect(out.refIdEntityType).toBe("withdrawal");
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]!.txType).toBe(PointTxType.WITHDRAWAL_ESCROW);
  });

  it("returns 404 when no rows match refId", async () => {
    findByRefForWallet.mockResolvedValue([]);
    await expect(
      pointWalletService.getTransactionsByRefId(USER_ID, "missing"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
