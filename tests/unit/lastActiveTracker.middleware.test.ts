import { describe, it, expect, vi, beforeEach } from "vitest";

const redisSet = vi.fn();
const userUpdate = vi.fn();

vi.mock("../../src/config/redis", () => ({
  redisClient: {
    set: (...a: unknown[]) => redisSet(...a),
  },
  RedisKeys: {
    userLastActive: (userId: string) => `user:lastActive:${userId}`,
  },
  USER_LAST_ACTIVE_THROTTLE_TTL: 600,
}));

vi.mock("../../src/config/database", () => ({
  prisma: {
    user: {
      update: (...a: unknown[]) => userUpdate(...a),
    },
  },
}));

import { lastActiveTracker } from "../../src/middlewares/lastActiveTracker.middleware";

describe("lastActiveTracker", () => {
  beforeEach(() => {
    redisSet.mockReset();
    userUpdate.mockReset();
  });

  it("writes lastActiveAt when Redis SET NX succeeds", async () => {
    redisSet.mockResolvedValueOnce("OK");
    await lastActiveTracker(
      { userId: "u1" } as never,
      {} as never,
    );
    expect(redisSet).toHaveBeenCalledWith(
      "user:lastActive:u1",
      "1",
      "EX",
      600,
      "NX",
    );
    expect(userUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips DB write when NX fails (key already present)", async () => {
    redisSet.mockResolvedValueOnce(null);
    await lastActiveTracker(
      { userId: "u1" } as never,
      {} as never,
    );
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("no-op without userId", async () => {
    await lastActiveTracker({} as never, {} as never);
    expect(redisSet).not.toHaveBeenCalled();
  });
});
