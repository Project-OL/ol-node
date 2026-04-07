import { describe, expect, it } from "vitest";
import { computeLevel } from "../../src/services/user-level.service";

const sample = [
  { level: 1, threshold: 0n },
  { level: 2, threshold: 3000n },
  { level: 3, threshold: 6000n },
];

describe("computeLevel", () => {
  it("returns 1 at zero cumulative", () => {
    expect(computeLevel(0n, sample)).toBe(1);
  });

  it("returns 2 when at second threshold", () => {
    expect(computeLevel(3000n, sample)).toBe(2);
  });

  it("returns highest level whose threshold is still <= total", () => {
    expect(computeLevel(5000n, sample)).toBe(2);
    expect(computeLevel(5999n, sample)).toBe(2);
    expect(computeLevel(6000n, sample)).toBe(3);
  });

  it("handles totals above max threshold", () => {
    expect(computeLevel(999_999_999n, sample)).toBe(3);
  });
});
