import { describe, expect, it } from "vitest";
import { computeLevel } from "../../src/services/user-level.service";
import {
  DEFAULT_WEALTH_LEVEL_THRESHOLDS,
  WEALTH_MAX_LEVEL,
} from "../../src/config/wallet-level-thresholds.defaults";

describe("DEFAULT_WEALTH_LEVEL_THRESHOLDS", () => {
  it("has 200 levels ending at max 200", () => {
    expect(DEFAULT_WEALTH_LEVEL_THRESHOLDS).toHaveLength(200);
    expect(DEFAULT_WEALTH_LEVEL_THRESHOLDS[0]).toEqual({
      level: 1,
      threshold: 0n,
    });
    expect(DEFAULT_WEALTH_LEVEL_THRESHOLDS[199]).toEqual({
      level: 200,
      threshold: 169_980_000_000n,
    });
    expect(WEALTH_MAX_LEVEL).toBe(200);
  });

  it("thresholds are strictly increasing", () => {
    for (let i = 1; i < DEFAULT_WEALTH_LEVEL_THRESHOLDS.length; i++) {
      const prev = DEFAULT_WEALTH_LEVEL_THRESHOLDS[i - 1]!.threshold;
      const cur = DEFAULT_WEALTH_LEVEL_THRESHOLDS[i]!.threshold;
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it("computeLevel matches product examples", () => {
    expect(computeLevel(0n, DEFAULT_WEALTH_LEVEL_THRESHOLDS)).toBe(1);
    expect(computeLevel(2_850n, DEFAULT_WEALTH_LEVEL_THRESHOLDS)).toBe(2);
    expect(computeLevel(2_849n, DEFAULT_WEALTH_LEVEL_THRESHOLDS)).toBe(1);
    expect(
      computeLevel(169_980_000_000n, DEFAULT_WEALTH_LEVEL_THRESHOLDS),
    ).toBe(200);
    expect(
      computeLevel(200_000_000_000n, DEFAULT_WEALTH_LEVEL_THRESHOLDS),
    ).toBe(200);
  });
});
