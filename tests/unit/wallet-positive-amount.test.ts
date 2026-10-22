import { describe, it, expect, vi, beforeEach } from "vitest";
import { CoinTxType, LedgerDirection, PointTxType } from "@prisma/client";

// F21: zero / negative / non-BigInt amounts never reach a wallet ledger.

vi.mock("../../src/config/database", () => ({ prisma: {}, prismaRead: {} }));
vi.mock("../../src/services/wallet.service", () => ({ walletService: {} }));
vi.mock("../../src/services/audit.service", () => ({ auditService: { log: vi.fn() } }));
vi.mock("../../src/services/user-level.service", () => ({ walletLevelService: {} }));
vi.mock("../../src/services/withdrawal.service", () => ({ withdrawalService: {} }));
vi.mock("../../src/services/rich-tier.service", () => ({
  RECHARGE_TX_TYPES: new Set(),
  richTierService: {},
}));

import { assertPositiveAmount } from "../../src/utils/transaction-amount-steps";
import { coinLedgerRepository } from "../../src/repositories/coin-ledger.repository";
import { pointLedgerRepository } from "../../src/repositories/point-ledger.repository";
import { coinWalletService } from "../../src/services/coin-wallet.service";
import { pointWalletService } from "../../src/services/point-wallet.service";

const BAD = [0n, -1n, -500n, 5 as unknown, "5" as unknown, 1.5 as unknown, null as unknown];

function expectInvalid(fn: () => unknown) {
  try {
    fn();
    expect.fail("expected INVALID_AMOUNT");
  } catch (e) {
    expect(e).toMatchObject({ statusCode: 400, code: "INVALID_AMOUNT" });
  }
}

async function expectInvalidAsync(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({ statusCode: 400, code: "INVALID_AMOUNT" });
}

/** A transaction client whose every model call is a spy, so we can assert nothing was touched. */
function spyTx() {
  const calls: string[] = [];
  const model = (name: string) =>
    new Proxy({}, { get: (_, op) => vi.fn(async () => { calls.push(`${name}.${String(op)}`); return null; }) });
  const tx = new Proxy({}, { get: (_, m) => model(String(m)) });
  return { tx: tx as never, calls };
}

describe("assertPositiveAmount", () => {
  it("accepts a positive BigInt", () => {
    expect(() => assertPositiveAmount(1n)).not.toThrow();
    expect(() => assertPositiveAmount(10_000_000_000n)).not.toThrow();
  });

  it.each(BAD.map((v) => [String(v), v]))("rejects %s", (_l, v) => {
    expectInvalid(() => assertPositiveAmount(v));
  });
});

describe("ledger repositories (backstop)", () => {
  const row = (amount: unknown) => ({
    walletId: "w1",
    direction: LedgerDirection.CREDIT,
    amount: amount as bigint,
    balanceAfter: 10n,
    idempotencyKey: "k1",
  });

  it("coin insert rejects 0 and negatives without writing", async () => {
    for (const a of [0n, -3n]) {
      const { tx, calls } = spyTx();
      await expectInvalidAsync(
        Promise.resolve().then(() =>
          coinLedgerRepository.insert(tx, { ...row(a), txType: CoinTxType.ADJUSTMENT }),
        ),
      );
      expect(calls).toEqual([]);
    }
  });

  it("point insert rejects 0 and negatives without writing", async () => {
    for (const a of [0n, -3n]) {
      const { tx, calls } = spyTx();
      await expectInvalidAsync(
        Promise.resolve().then(() =>
          pointLedgerRepository.insert(tx, { ...row(a), txType: PointTxType.ADJUSTMENT }),
        ),
      );
      expect(calls).toEqual([]);
    }
  });

  it("a positive amount is written", async () => {
    const create = vi.fn().mockResolvedValue({ id: "e1" });
    const tx = { coinLedgerEntry: { create } } as never;
    await coinLedgerRepository.insert(tx, { ...row(7n), txType: CoinTxType.ADJUSTMENT });
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("wallet service entry points", () => {
  beforeEach(() => vi.clearAllMocks());

  it("coin debit: a negative amount cannot act as a credit", async () => {
    const { tx, calls } = spyTx();
    await expectInvalidAsync(
      coinWalletService.debit("u1", -100n, CoinTxType.ADJUSTMENT, tx, { idempotencyKey: "k" }),
    );
    expect(calls).toEqual([]);
  });

  it("coin credit rejects 0", async () => {
    const { tx, calls } = spyTx();
    await expectInvalidAsync(
      coinWalletService.credit("u1", 0n, CoinTxType.ADJUSTMENT, tx, {
        idempotencyKey: "k",
        applyWealthCredit: false,
      }),
    );
    expect(calls).toEqual([]);
  });

  it("point debit / escrow / creditInTransaction reject 0 and negatives", async () => {
    for (const a of [0n, -1n]) {
      const { tx, calls } = spyTx();
      await expectInvalidAsync(
        pointWalletService.debit("u1", a, PointTxType.ADJUSTMENT, tx, { idempotencyKey: "k" }),
      );
      await expectInvalidAsync(
        pointWalletService.escrow("u1", a, PointTxType.WITHDRAWAL_ESCROW, tx, { idempotencyKey: "k" }),
      );
      await expectInvalidAsync(
        pointWalletService.creditInTransaction("u1", a, PointTxType.ADJUSTMENT, tx, {
          idempotencyKey: "k",
        }),
      );
      expect(calls).toEqual([]);
    }
  });

  it("point creditPoints rejects 0 before taking the idempotency lock", async () => {
    await expectInvalidAsync(
      pointWalletService.creditPoints({
        userId: "u1",
        amount: 0n,
        txType: PointTxType.ADJUSTMENT,
        idempotencyKey: "k",
      }),
    );
  });
});
