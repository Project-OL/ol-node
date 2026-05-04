import { describe, it, expect } from "vitest";
import { VipMembershipTier } from "@prisma/client";
import { AppError } from "../../src/middlewares/errorHandler";
import {
  computeProposedExpiresAt,
  assertWithinCap,
  fanSpendIncrementForGift,
  DIAMOND_PERIOD_DAYS,
  SVIP_PERIOD_DAYS,
  VIP_DURATION_CAP_DAYS,
} from "../../src/services/vip-membership.helpers";
import { addUtcDays } from "../../src/utils/datetime";

describe("vip membership stacking math", () => {
  it("Diamond on top of active SVIP extends from current expiry", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const currentExpires = new Date("2026-08-01T00:00:00.000Z");
    const proposed = computeProposedExpiresAt({
      now,
      currentExpiresAt: currentExpires,
      periodDays: DIAMOND_PERIOD_DAYS,
    });
    expect(proposed.toISOString()).toBe(
      addUtcDays(currentExpires, DIAMOND_PERIOD_DAYS).toISOString(),
    );
  });

  it("purchase from zero state extends from now", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const proposed = computeProposedExpiresAt({
      now,
      currentExpiresAt: null,
      periodDays: DIAMOND_PERIOD_DAYS,
    });
    expect(proposed.toISOString()).toBe(
      addUtcDays(now, DIAMOND_PERIOD_DAYS).toISOString(),
    );
  });

  it("SVIP on top of Diamond stacks correctly", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const currentExpires = new Date("2026-06-01T00:00:00.000Z");
    const proposed = computeProposedExpiresAt({
      now,
      currentExpiresAt: currentExpires,
      periodDays: SVIP_PERIOD_DAYS,
    });
    expect(proposed.toISOString()).toBe(
      addUtcDays(currentExpires, SVIP_PERIOD_DAYS).toISOString(),
    );
  });

  it("Diamond ×3 stacks from max(now, expiry)", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    let exp: Date | null = null;
    for (let i = 0; i < 3; i++) {
      exp = computeProposedExpiresAt({
        now,
        currentExpiresAt: exp,
        periodDays: DIAMOND_PERIOD_DAYS,
      });
    }
    const expected = addUtcDays(now, DIAMOND_PERIOD_DAYS * 3);
    expect(exp!.toISOString()).toBe(expected.toISOString());
  });

  it("cap at 2 years rejects", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const proposed = addUtcDays(now, VIP_DURATION_CAP_DAYS + 1);
    try {
      assertWithinCap(proposed, now, VIP_DURATION_CAP_DAYS);
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe("VIP_DURATION_CAP");
    }
  });

  it("cap allows exactly at boundary", () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const proposed = addUtcDays(now, VIP_DURATION_CAP_DAYS);
    expect(() =>
      assertWithinCap(proposed, now, VIP_DURATION_CAP_DAYS),
    ).not.toThrow();
  });
});

describe("fan spend VIP boost (BigInt)", () => {
  it.each([
    [1n, true, 1n],
    [5n, true, 6n],
    [7n, true, 8n],
    [100n, true, 120n],
    [100n, false, 100n],
  ] as const)("coinCost %s vip=%s → %s", (cost, vip, expected) => {
    expect(fanSpendIncrementForGift(cost, vip)).toBe(expected);
  });
});

describe("tier constants", () => {
  it("SVIP is 365 days", () => {
    expect(SVIP_PERIOD_DAYS).toBe(365);
  });
  it("enum values stable", () => {
    expect(VipMembershipTier.DIAMOND).toBe("DIAMOND");
    expect(VipMembershipTier.SVIP).toBe("SVIP");
  });
});
