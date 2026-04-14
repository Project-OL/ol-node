import { describe, it, expect } from "vitest";
import { getActivePeriod, getMonthEndIso } from "../../src/utils/galleryPeriod";

describe("galleryPeriod", () => {
  it("getActivePeriod: month boundaries UTC and non-negative secondsRemaining", () => {
    const now = new Date(Date.UTC(2026, 3, 15, 12, 0, 0, 0));
    const p = getActivePeriod(now);
    expect(p.year).toBe(2026);
    expect(p.month).toBe(4);
    expect(p.periodStart.getTime()).toBe(Date.UTC(2026, 3, 1, 0, 0, 0, 0));
    expect(p.periodEnd.getTime()).toBe(Date.UTC(2026, 4, 1, 0, 0, 0, 0) - 1);
    expect(p.secondsRemaining).toBeGreaterThanOrEqual(0);
  });

  it("getMonthEndIso matches periodEnd ISO", () => {
    const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 0));
    const p = getActivePeriod(now);
    expect(getMonthEndIso(now)).toBe(p.periodEnd.toISOString());
  });
});
