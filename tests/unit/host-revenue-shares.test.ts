import { describe, expect, it } from "vitest";
import {
  hostGiftPointsFromCoinSpend,
  hostRevenuePointsFromCoins,
} from "../../src/config/host-revenue-shares";

describe("host revenue shares", () => {
  it("credits 60% of gift coins as points", () => {
    expect(hostGiftPointsFromCoinSpend(100_000)).toBe(60_000);
    expect(hostGiftPointsFromCoinSpend(500)).toBe(300);
    expect(hostGiftPointsFromCoinSpend(1)).toBe(0);
  });

  it("credits 50% of subscription/guardian coins as points", () => {
    expect(hostRevenuePointsFromCoins(5000n)).toBe(2500n);
    expect(hostRevenuePointsFromCoins(150_000n)).toBe(75_000n);
    expect(hostRevenuePointsFromCoins(0n)).toBe(0n);
  });
});
