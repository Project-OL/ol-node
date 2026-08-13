import { describe, it, expect } from "vitest";
import {
  agencyCommissionRollingWindowDays,
  resolveCommissionPeriod,
  utcDayFromTimestamp,
  utcRollingPeriodDays,
} from "../../src/utils/datetime";
import { AppError } from "../../src/middlewares/errorHandler";

describe("agency commission UTC helpers", () => {
  it("rolling window uses today as the latest day", () => {
    // Commission query periods include today (2026-08-07) — the rolling window
    // ends on today UTC, not yesterday.
    const now = new Date("2026-05-04T15:30:00.000Z");
    const { fromDay, toDay } = agencyCommissionRollingWindowDays(now);
    expect(toDay.toISOString().slice(0, 10)).toBe("2026-05-04");
    expect(fromDay.toISOString().slice(0, 10)).toBe("2026-04-04");
  });

  it("utcDayFromTimestamp normalizes to UTC midnight", () => {
    const d = utcDayFromTimestamp(new Date("2026-05-04T23:59:59.999Z"));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCDate()).toBe(4);
  });

  it("resolveCommissionPeriod accepts inclusive from/to", () => {
    const { start, end } = resolveCommissionPeriod({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(start.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(end.toISOString().slice(0, 10)).toBe("2026-01-31");
  });

  it("resolveCommissionPeriod rejects from after to", () => {
    expect(() =>
      resolveCommissionPeriod({ from: "2026-02-01", to: "2026-01-01" }),
    ).toThrow(AppError);
  });

  it("resolveCommissionPeriod falls back to periodDays", () => {
    const { start, end } = resolveCommissionPeriod({ periodDays: 7 });
    const expected = utcRollingPeriodDays(7);
    expect(start.toISOString()).toBe(expected.fromDay.toISOString());
    expect(end.toISOString()).toBe(expected.toDay.toISOString());
  });
});
