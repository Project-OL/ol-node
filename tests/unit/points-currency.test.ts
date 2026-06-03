import { describe, it, expect } from "vitest";
import { formatPointsAsUsd } from "../../src/utils/points-currency";

describe("formatPointsAsUsd", () => {
  it("converts at 10_000 points per USD with two decimals", () => {
    expect(formatPointsAsUsd(700_000n)).toBe("70.00");
    expect(formatPointsAsUsd(0n)).toBe("0.00");
    expect(formatPointsAsUsd(1n)).toBe("0.00");
    expect(formatPointsAsUsd(10_000n)).toBe("1.00");
    expect(formatPointsAsUsd(10_001n)).toBe("1.00");
  });
});
