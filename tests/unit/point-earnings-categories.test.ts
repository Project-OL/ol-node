import { describe, expect, it } from "vitest";
import { PointTxType } from "@prisma/client";
import {
  POINT_EARNINGS_CATEGORIES,
  resolvePointHistoryTxTypes,
  sumCreditsByCategory,
} from "../../src/config/point-earnings-categories";

describe("point earnings categories", () => {
  it("expands livestream category to gift, video call, and livestream gift types", () => {
    const types = resolvePointHistoryTxTypes(["livestream"]);
    expect(types).toEqual(
      expect.arrayContaining([
        PointTxType.LIVESTREAM_GIFT,
        PointTxType.VIDEO_CALL,
        PointTxType.GIFT_RECEIVE,
      ]),
    );
    expect(types).toHaveLength(3);
  });

  it("expands subscription category to subscription and guardian purchase", () => {
    const types = resolvePointHistoryTxTypes(["subscription"]);
    expect(types).toEqual(
      expect.arrayContaining([
        PointTxType.SUBSCRIPTION,
        PointTxType.GUARDIAN_PURCHASE,
      ]),
    );
  });

  it("expands guardian alias to GUARDIAN_PURCHASE only", () => {
    expect(resolvePointHistoryTxTypes(["guardian"])).toEqual([
      PointTxType.GUARDIAN_PURCHASE,
    ]);
  });

  it("rolls guardian credits into subscription earnings bucket", () => {
    const earnings = sumCreditsByCategory({
      [PointTxType.GUARDIAN_PURCHASE]: 75_000n,
      [PointTxType.SUBSCRIPTION]: 2500n,
    });
    expect(earnings.subscription).toBe("77500");
  });

  it("expands commission category including payroll types", () => {
    const types = resolvePointHistoryTxTypes(["commission"]);
    expect(types).toEqual(
      expect.arrayContaining([
        PointTxType.COMMISSION,
        PointTxType.AGENT_COMMISSION,
        PointTxType.PAYROLL_PROCESSING_REWARD,
        PointTxType.PAYROLL_HOST_PAYOUT,
      ]),
    );
    expect(types).toHaveLength(4);
  });

  it("merges multiple categories and dedupes raw types", () => {
    const types = resolvePointHistoryTxTypes([
      "transfer",
      "TRANSFER_IN",
      "subscription",
    ]);
    expect(types).toContain(PointTxType.SUBSCRIPTION);
    expect(types).toContain(PointTxType.TRANSFER_OUT);
    expect(types).toContain(PointTxType.AGENT_POINT_TRANSFER);
    expect(types?.filter((t) => t === PointTxType.TRANSFER_IN)).toHaveLength(1);
  });

  it("rejects unknown filter values", () => {
    expect(() => resolvePointHistoryTxTypes(["mysteryChest"])).toThrow(
      /Invalid point history type filter/,
    );
  });

  it("sums credits into category buckets for summary", () => {
    const earnings = sumCreditsByCategory({
      [PointTxType.GIFT_RECEIVE]: 100n,
      [PointTxType.VIDEO_CALL]: 50n,
      [PointTxType.AGENT_COMMISSION]: 30n,
      [PointTxType.PAYROLL_HOST_PAYOUT]: 20n,
      [PointTxType.TRANSFER_IN]: 5n,
      [PointTxType.SUBSCRIPTION]: 7n,
      [PointTxType.PLATFORM_REWARD]: 3n,
    });
    expect(earnings.livestream).toBe("150");
    expect(earnings.commission).toBe("50");
    expect(earnings.subscription).toBe("7");
    expect(earnings.platform_reward).toBe("3");
    expect(earnings.transfer).toBe("5");
  });

  it("covers every category with at least one tx type", () => {
    for (const key of Object.keys(POINT_EARNINGS_CATEGORIES)) {
      expect(POINT_EARNINGS_CATEGORIES[key as keyof typeof POINT_EARNINGS_CATEGORIES].length).toBeGreaterThan(0);
    }
  });
});
