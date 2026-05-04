import { describe, it, expect } from "vitest";
import {
  agencyCommissionRollingWindowDays,
  utcDayFromTimestamp,
} from "../../src/utils/datetime";

describe("agency commission UTC helpers", () => {
  it("rolling window uses yesterday as latest full day", () => {
    const now = new Date("2026-05-04T15:30:00.000Z");
    const { fromDay, toDay } = agencyCommissionRollingWindowDays(now);
    expect(toDay.toISOString().slice(0, 10)).toBe("2026-05-03");
    expect(fromDay.toISOString().slice(0, 10)).toBe("2026-04-04");
  });

  it("utcDayFromTimestamp normalizes to UTC midnight", () => {
    const d = utcDayFromTimestamp(new Date("2026-05-04T23:59:59.999Z"));
    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCDate()).toBe(4);
  });
});
