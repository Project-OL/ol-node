import { describe, expect, it } from "vitest";
import { computeLevel } from "../../src/services/user-level.service";
import {
  DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS,
  LIVESTREAM_MAX_LEVEL,
} from "../../src/config/wallet-level-thresholds.defaults";

describe("DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS", () => {
  it("has 35 levels ending at max 35", () => {
    expect(DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS).toHaveLength(35);
    expect(DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS[0]).toEqual({
      level: 1,
      threshold: 0n,
    });
    expect(DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS[34]).toEqual({
      level: 35,
      threshold: 198_000_000_000n,
    });
    expect(LIVESTREAM_MAX_LEVEL).toBe(35);
  });

  it("thresholds are strictly increasing", () => {
    for (let i = 1; i < DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS.length; i++) {
      const prev = DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS[i - 1]!.threshold;
      const cur = DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS[i]!.threshold;
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it("computeLevel matches product examples", () => {
    expect(computeLevel(0n, DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS)).toBe(1);
    expect(computeLevel(9_500n, DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS)).toBe(2);
    expect(computeLevel(9_499n, DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS)).toBe(1);
    expect(
      computeLevel(198_000_000_000n, DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS),
    ).toBe(35);
    expect(
      computeLevel(500_000_000_000n, DEFAULT_LIVESTREAM_LEVEL_THRESHOLDS),
    ).toBe(35);
  });
});
