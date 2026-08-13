import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/middlewares/errorHandler";

const debit = vi.fn().mockResolvedValue({
  ledgerEntryId: "led-out",
  balanceAfter: 0n,
});
const creditInTransaction = vi.fn().mockResolvedValue({
  ledgerEntryId: "led-in",
  balanceAfter: 200_000n,
});

vi.mock("../../src/services/point-wallet.service", () => ({
  pointWalletService: {
    debit: (...a: unknown[]) => debit(...a),
    creditInTransaction: (...a: unknown[]) => creditInTransaction(...a),
  },
}));

const insertTransfer = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/repositories/agencyPointTransfer.repository", () => ({
  agencyPointTransferRepository: {
    insertTransfer: (...a: unknown[]) => insertTransfer(...a),
  },
}));

const adjustPointBalanceCache = vi.fn();

vi.mock("../../src/services/wallet.service", () => ({
  walletService: {
    adjustPointBalanceCache: (...a: unknown[]) => adjustPointBalanceCache(...a),
  },
}));

const isIndexedForUser = vi.fn();

vi.mock("../../src/repositories/faceVerification.repository", () => ({
  faceVerificationRepository: {
    isIndexedForUser: (...a: unknown[]) => isIndexedForUser(...a),
  },
}));

const prismaAgencyFindUnique = vi.fn();
const prismaAgentTransferFindUnique = vi.fn();
const prismaAgentTransferFindUniqueTx = vi.fn();
const prismaTransaction = vi.fn();

vi.mock("../../src/config/database", () => ({
  prisma: {
    agentPointTransfer: {
      findUnique: (...a: unknown[]) => prismaAgentTransferFindUniqueTx(...a),
    },
    $transaction: (...a: unknown[]) => prismaTransaction(...a),
  },
  prismaRead: {
    agency: {
      findUnique: (...a: unknown[]) => prismaAgencyFindUnique(...a),
    },
    agentPointTransfer: {
      findUnique: (...a: unknown[]) => prismaAgentTransferFindUnique(...a),
    },
  },
}));

import { agencyCommissionService } from "../../src/services/agencyCommission.service";

beforeEach(() => {
  vi.clearAllMocks();
  isIndexedForUser.mockResolvedValue(true);
  prismaAgencyFindUnique.mockResolvedValue({ userId: "a2" });
  prismaAgentTransferFindUnique.mockResolvedValue(null);
  prismaAgentTransferFindUniqueTx.mockResolvedValue(null);
  prismaTransaction.mockImplementation(async (fn: (t: unknown) => unknown) => {
    const tx = {
      agentPointTransfer: {
        findUnique: prismaAgentTransferFindUniqueTx,
      },
    };
    return fn(tx);
  });
});

describe("agencyCommissionService.transferPointsToAgent", () => {
  it("rejects below minimum", async () => {
    await expect(
      agencyCommissionService.transferPointsToAgent({
        senderUserId: "a1",
        recipientAgentUserId: "a2",
        points: 99_999n,
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ code: "MIN_TRANSFER_VIOLATION" });
    expect(prismaTransaction).not.toHaveBeenCalled();
  });

  it("rejects amount not multiple of 100,000", async () => {
    await expect(
      agencyCommissionService.transferPointsToAgent({
        senderUserId: "a1",
        recipientAgentUserId: "a2",
        points: 150_000n,
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT_STEP" });
    expect(prismaTransaction).not.toHaveBeenCalled();
  });

  it("rejects self-transfer", async () => {
    await expect(
      agencyCommissionService.transferPointsToAgent({
        senderUserId: "a1",
        recipientAgentUserId: "a1",
        points: 100_000n,
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RECIPIENT" });
  });

  it("rejects non-agent recipient", async () => {
    prismaAgencyFindUnique.mockResolvedValueOnce(null);
    await expect(
      agencyCommissionService.transferPointsToAgent({
        senderUserId: "a1",
        recipientAgentUserId: "na",
        points: 100_000n,
        idempotencyKey: "k1",
      }),
    ).rejects.toMatchObject({ code: "INVALID_RECIPIENT" });
  });

  it("allows non-agent sender when recipient is agent", async () => {
    await expect(
      agencyCommissionService.transferPointsToAgent({
        senderUserId: "non-agent-user",
        recipientAgentUserId: "a2",
        points: 100_000n,
        idempotencyKey: "k1",
      }),
    ).resolves.toMatchObject({ transferId: expect.any(String) });
  });

  it("happy path debits, credits, inserts audit row", async () => {
    const out = await agencyCommissionService.transferPointsToAgent({
      senderUserId: "a1",
      recipientAgentUserId: "a2",
      points: 200_000n,
      idempotencyKey: "idem-1",
    });

    expect(out.transferId).toEqual(expect.any(String));
    expect(debit).toHaveBeenCalledWith(
      "a1",
      200_000n,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ idempotencyKey: "idem-1:debit" }),
    );
    expect(creditInTransaction).toHaveBeenCalled();
    expect(insertTransfer).toHaveBeenCalled();
    expect(adjustPointBalanceCache).toHaveBeenCalledWith("a1", -200_000n);
    expect(adjustPointBalanceCache).toHaveBeenCalledWith("a2", 200_000n);
  });

  it("idempotent: existing row returns same transfer id without double debit", async () => {
    prismaAgentTransferFindUnique.mockResolvedValue({ id: "existing-tx" });

    const out = await agencyCommissionService.transferPointsToAgent({
      senderUserId: "a1",
      recipientAgentUserId: "a2",
      points: 100_000n,
      idempotencyKey: "idem-dup",
    });

    expect(out.transferId).toBe("existing-tx");
    expect(prismaTransaction).not.toHaveBeenCalled();
    expect(debit).not.toHaveBeenCalled();
  });

  it("propagates insufficient balance from debit", async () => {
    debit.mockRejectedValueOnce(
      new AppError(400, "Insufficient points", "INSUFFICIENT_POINTS"),
    );

    await expect(
      agencyCommissionService.transferPointsToAgent({
        senderUserId: "a1",
        recipientAgentUserId: "a2",
        points: 500_000n,
        idempotencyKey: "idem-ins",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_POINTS" });
  });
});
