import { describe, expect, it } from "vitest";
import {
  applyRetentionRule,
  computeTier,
  retentionLandingTier,
  RICH_TIER_THRESHOLDS,
  thresholdForTier,
} from "../../src/services/rich-tier.service";
import { utcMonthBoundsExclusive, utcYearMonth } from "../../src/utils/datetime";

describe("computeTier", () => {
  it("returns 0 below first threshold", () => {
    expect(computeTier(0n)).toBe(0);
    expect(computeTier(2_999_999n)).toBe(0);
  });

  it("is exact at each threshold and just below next", () => {
    for (let t = 1; t <= 10; t++) {
      const th = thresholdForTier(t);
      expect(computeTier(th - 1n)).toBe(t - 1);
      expect(computeTier(th)).toBe(t);
    }
    expect(computeTier(thresholdForTier(10) + 1n)).toBe(10);
  });

  it("handles amounts far above tier X", () => {
    expect(computeTier(9_000_000_000n)).toBe(10);
  });
});

describe("retentionLandingTier", () => {
  it("I–II → none, III–VI → 2 below, VII–IX → 3 below, X → VII", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(retentionLandingTier)).toEqual([
      0, 0, 0, 1, 2, 3, 4, 4, 5, 6, 7,
    ]);
  });
});

describe("applyRetentionRule", () => {
  it("returns 0 for tiers 0–2", () => {
    expect(applyRetentionRule(0)).toBe(0n);
    expect(applyRetentionRule(1)).toBe(0n);
    expect(applyRetentionRule(2)).toBe(0n);
  });

  it("lands on the landing tier, halfway to the next one (default ladder)", () => {
    expect(applyRetentionRule(3)).toBe(4_000_000n); // I: 3M + (5M-3M)/2
    expect(applyRetentionRule(4)).toBe(7_500_000n); // II: 5M + (10M-5M)/2
    expect(applyRetentionRule(5)).toBe(15_000_000n); // III
    expect(applyRetentionRule(6)).toBe(25_000_000n); // IV
    expect(applyRetentionRule(7)).toBe(25_000_000n); // IV
    expect(applyRetentionRule(8)).toBe(40_000_000n); // V
    expect(applyRetentionRule(9)).toBe(75_000_000n); // VI
    expect(applyRetentionRule(10)).toBe(150_000_000n); // VII
  });

  it("carryover always computes back to exactly the landing tier", () => {
    for (let t = 0; t <= 10; t++) {
      expect(computeTier(applyRetentionRule(t))).toBe(retentionLandingTier(t));
    }
  });

  it("uses a custom ladder", () => {
    const ladder = Array.from({ length: 10 }, (_, i) => ({
      tier: i + 1,
      minRechargeCoins: BigInt((i + 1) * 100),
      displayName: `T${i + 1}`,
    }));
    expect(applyRetentionRule(3, ladder)).toBe(150n); // 100 + (200-100)/2
    expect(thresholdForTier(1, ladder)).toBe(100n);
  });
});

describe("utcYearMonth / utcMonthBoundsExclusive", () => {
  it("wraps December to January next year", () => {
    const d = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
    expect(utcYearMonth(d)).toEqual({ year: 2026, month: 12 });
    const jan = new Date(Date.UTC(2027, 0, 1, 0, 0, 0));
    expect(utcYearMonth(jan)).toEqual({ year: 2027, month: 1 });
  });

  it("February leap year end in UTC", () => {
    const leapEnd = new Date(Date.UTC(2024, 1, 29, 23, 59, 59));
    expect(utcYearMonth(leapEnd)).toEqual({ year: 2024, month: 2 });
    const bounds = utcMonthBoundsExclusive(2024, 2);
    expect(bounds.start.toISOString()).toBe("2024-02-01T00:00:00.000Z");
    expect(bounds.endExclusive.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("month bounds for non-leap February", () => {
    const { endExclusive } = utcMonthBoundsExclusive(2025, 2);
    expect(endExclusive.toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });
});

describe("RICH_TIER_THRESHOLDS", () => {
  it("matches documented ladder", () => {
    expect(RICH_TIER_THRESHOLDS[0]).toBe(3_000_000n);
    expect(RICH_TIER_THRESHOLDS[9]).toBe(1_000_000_000n);
  });
});
