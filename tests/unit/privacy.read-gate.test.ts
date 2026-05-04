import { describe, it, expect, vi, beforeEach } from "vitest";

const findPrivacyFlagsBulk = vi.fn();
const userFindById = vi.fn();
const userUpdate = vi.fn();

vi.mock("../../src/repositories/user.repository", () => ({
  userRepository: {
    findPrivacyFlagsBulk: (...a: unknown[]) => findPrivacyFlagsBulk(...a),
    findById: (...a: unknown[]) => userFindById(...a),
    update: (...a: unknown[]) => userUpdate(...a),
  },
}));

const hasActive = vi.fn();
const hasActiveBulk = vi.fn();

vi.mock("../../src/services/vip-membership.service", () => ({
  vipMembershipService: {
    hasActive: (...a: unknown[]) => hasActive(...a),
    hasActiveBulk: (...a: unknown[]) => hasActiveBulk(...a),
  },
}));

vi.mock("../../src/services/cache.service", () => ({
  cacheService: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("../../src/services/audit.service", () => ({
  auditService: {
    log: vi.fn(),
  },
}));

import { privacyService } from "../../src/services/privacy.service";

describe("privacyService getEffectiveFlags (read-gate)", () => {
  beforeEach(() => {
    findPrivacyFlagsBulk.mockReset();
    hasActive.mockReset();
    hasActiveBulk.mockReset();
  });

  it("all false when VIP inactive even if raw flags true", async () => {
    findPrivacyFlagsBulk.mockResolvedValue([
      {
        id: "u1",
        privacyInvisibleVisitor: true,
        privacyMysteryLive: true,
        privacyMysteryRank: true,
        privacyInvisibleOnline: true,
      },
    ]);
    hasActive.mockResolvedValue(false);
    const f = await privacyService.getEffectiveFlags("u1");
    expect(f).toEqual({
      invisibleVisitor: false,
      mysteryInLive: false,
      mysteryOnRank: false,
      invisibleOnline: false,
    });
  });

  it("raw flags pass through when VIP active", async () => {
    findPrivacyFlagsBulk.mockResolvedValue([
      {
        id: "u1",
        privacyInvisibleVisitor: true,
        privacyMysteryLive: false,
        privacyMysteryRank: true,
        privacyInvisibleOnline: false,
      },
    ]);
    hasActive.mockResolvedValue(true);
    const f = await privacyService.getEffectiveFlags("u1");
    expect(f).toEqual({
      invisibleVisitor: true,
      mysteryInLive: false,
      mysteryOnRank: true,
      invisibleOnline: false,
    });
  });

  it("getEffectiveFlagsBulk uses single hasActiveBulk", async () => {
    findPrivacyFlagsBulk.mockResolvedValue([
      {
        id: "a",
        privacyInvisibleVisitor: true,
        privacyMysteryLive: false,
        privacyMysteryRank: false,
        privacyInvisibleOnline: false,
      },
      {
        id: "b",
        privacyInvisibleVisitor: false,
        privacyMysteryLive: true,
        privacyMysteryRank: false,
        privacyInvisibleOnline: false,
      },
    ]);
    hasActiveBulk.mockResolvedValue(
      new Map<string, boolean>([
        ["a", true],
        ["b", false],
      ]),
    );
    const m = await privacyService.getEffectiveFlagsBulk(["a", "b"]);
    expect(hasActiveBulk).toHaveBeenCalledTimes(1);
    expect(m.get("a")).toEqual({
      invisibleVisitor: true,
      mysteryInLive: false,
      mysteryOnRank: false,
      invisibleOnline: false,
    });
    expect(m.get("b")).toEqual({
      invisibleVisitor: false,
      mysteryInLive: false,
      mysteryOnRank: false,
      invisibleOnline: false,
    });
  });
});

describe("privacyService non-gate writes", () => {
  beforeEach(() => {
    userFindById.mockReset();
    userUpdate.mockReset();
  });

  it("toggle invisible visitor succeeds for non-VIP user (no write gate)", async () => {
    userFindById.mockResolvedValue({
      id: "u1",
      privacyInvisibleVisitor: false,
      privacyMysteryLive: false,
      privacyMysteryRank: false,
      privacyInvisibleOnline: false,
      hideMicStatus: false,
      vipSubscriptionActive: false,
    });
    userUpdate.mockResolvedValue({} as never);

    await privacyService.toggleInvisibleVisitor("u1", true);
    expect(userUpdate).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ privacyInvisibleVisitor: true }),
    );
  });
});
