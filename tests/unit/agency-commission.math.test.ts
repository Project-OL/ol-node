import { describe, it, expect } from "vitest";
import { PointTxType } from "@prisma/client";
import {
  COMMISSION_ELIGIBLE_TX_TYPES,
  LIVE_COMMISSION_TX_TYPES,
  MATCH_CHAT_COMMISSION_TX_TYPES,
} from "../../src/services/agencyCommission.service";

describe("agency commission math / sets", () => {
  it("commission = (points * bp) / 10000 with truncation", () => {
    expect((1n * 400n) / 10000n).toBe(0n);
    expect((100_000n * 400n) / 10000n).toBe(4000n);
    expect((100_000n * 2400n) / 10000n).toBe(24_000n);
    expect((10_000_000_000_000n * 400n) / 10000n).toBe(400_000_000_000n);
  });

  it("eligibility sets union and exclusions", () => {
    expect(LIVE_COMMISSION_TX_TYPES.has(PointTxType.GIFT_RECEIVE)).toBe(true);
    expect(MATCH_CHAT_COMMISSION_TX_TYPES.has(PointTxType.VIDEO_CALL)).toBe(true);
    expect(COMMISSION_ELIGIBLE_TX_TYPES.has(PointTxType.PLATFORM_REWARD)).toBe(
      false,
    );
  });
});
