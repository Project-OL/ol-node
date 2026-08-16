import { describe, it, expect } from "vitest";
import { PointTxType } from "@prisma/client";
import {
  buildPointAmountBreakdown,
  resolvePointLedgerRefId,
} from "../../src/utils/point-transaction-amounts";

describe("resolvePointLedgerRefId", () => {
  it("prefers column refId", () => {
    expect(resolvePointLedgerRefId("wd-1", { transferId: "t2" })).toBe("wd-1");
  });

  it("falls back to metadata.transferId", () => {
    expect(
      resolvePointLedgerRefId(null, { transferId: "transfer-uuid" }),
    ).toBe("transfer-uuid");
  });
});

describe("buildPointAmountBreakdown", () => {
  it("builds standard conversion for gift credit", () => {
    const out = buildPointAmountBreakdown(
      {
        txType: PointTxType.GIFT_RECEIVE,
        amount: 100_000n,
        refId: "gift-tx-1",
        metadata: null,
        withdrawal: null,
      },
      { code: "INR", rate: 86 },
    );
    expect(out.points).toBe("100000");
    expect(out.usdAmount).toBe("10.00");
    expect(out.pointsPerUsd).toBe(10_000);
    expect(out.conversionLabel).toBe("$10.00 = 100,000 points");
    expect(out.localCurrency).toEqual({
      code: "INR",
      amount: "860.00",
      usdBasis: "10.00",
    });
    expect(out.actualAmountReceivedUsd).toBe("10.00");
  });

  it("uses host payout USD for payroll host credit", () => {
    const out = buildPointAmountBreakdown(
      {
        txType: PointTxType.PAYROLL_HOST_PAYOUT,
        amount: 94_000n,
        refId: "wd-1",
        metadata: null,
        withdrawal: {
          grossPoints: 100_000n,
          hostPayoutUsd: { toString: () => "9.40" } as never,
          platformFeePoints: 6_000n,
        },
      },
      { code: "INR", rate: 86 },
    );
    expect(out.usdAmount).toBe("9.40");
    expect(out.actualAmountReceivedUsd).toBe("9.40");
    expect(out.localCurrency?.amount).toBe("808.40");
  });

  it("uses NPR when the viewer FX is Nepal", () => {
    const out = buildPointAmountBreakdown(
      {
        txType: PointTxType.GIFT_RECEIVE,
        amount: 100_000n,
        refId: null,
        metadata: null,
        withdrawal: null,
      },
      { code: "NPR", rate: 150 },
    );
    expect(out.localCurrency).toEqual({
      code: "NPR",
      amount: "1500.00",
      usdBasis: "10.00",
    });
  });
});
