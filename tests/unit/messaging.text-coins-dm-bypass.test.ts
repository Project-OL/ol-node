import { describe, it, expect, vi, beforeEach } from "vitest";

const { isBlocked, getOrCreateSettings, existsFollow } = vi.hoisted(() => ({
  isBlocked: vi.fn().mockResolvedValue(false),
  getOrCreateSettings: vi.fn().mockResolvedValue({
    allowMsgFromMutual: false,
    allowMsgFromFollowing: false,
    allowMsgFromStranger: false,
  }),
  existsFollow: vi.fn(),
}));

vi.mock("../../src/repositories/block.repository", () => ({
  blockRepository: { isBlocked },
}));
vi.mock("../../src/services/userSettings.service", () => ({
  userSettingsService: { getOrCreateSettings },
}));
vi.mock("../../src/repositories/follow.repository", () => ({
  followRepository: { existsFollow },
}));
vi.mock("../../src/services/userRestriction.service", () => ({
  userRestrictionService: {
    assertNotRestricted: vi.fn().mockResolvedValue(undefined),
    assertMessagingAllowed: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/config/redis", () => ({
  redisClient: {
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
  },
  getRedisForRead: () => ({
    get: vi.fn().mockResolvedValue(null),
  }),
  RedisKeys: {
    allowedMessaging: (a: string, b: string) => `allowed:${a}:${b}`,
  },
}));

import { messagingService } from "../../src/services/messaging.service";

describe("canUserMessage bypassDmPrivacy (TEXT_COINS / coinseller)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isBlocked.mockResolvedValue(false);
  });

  it("allows messaging when bypassDmPrivacy despite all DM toggles off", async () => {
    await expect(
      messagingService.canUserMessage("sender", "recipient", {
        bypassDmPrivacy: true,
      }),
    ).resolves.toBeUndefined();
    expect(getOrCreateSettings).not.toHaveBeenCalled();
    expect(existsFollow).not.toHaveBeenCalled();
  });

  it("still enforces blocks when bypassDmPrivacy", async () => {
    isBlocked.mockImplementation(async (_r: string, s: string) => s === "sender");
    await expect(
      messagingService.canUserMessage("sender", "recipient", {
        bypassDmPrivacy: true,
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "USER_BLOCKED" });
  });

  it("applies DM privacy when bypassDmPrivacy is false", async () => {
    await expect(
      messagingService.canUserMessage("sender", "recipient"),
    ).rejects.toMatchObject({ statusCode: 403, code: "MESSAGING_NOT_ALLOWED" });
    expect(getOrCreateSettings).toHaveBeenCalled();
  });
});
