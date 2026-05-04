import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../config/database";
import {
  RedisKeys,
  USER_LAST_ACTIVE_THROTTLE_TTL,
  redisClient,
} from "../config/redis";

/**
 * Cheap activity timestamp for agency removal rules. Runs after JWT auth (`authenticate`).
 * Writes DB at most once per USER_LAST_ACTIVE_THROTTLE_TTL seconds per user (Redis gate).
 */
export async function lastActiveTracker(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const userId = request.userId;
  if (!userId) return;

  const gateKey = RedisKeys.userLastActive(userId);
  try {
    const ok = await redisClient.set(
      gateKey,
      "1",
      "EX",
      USER_LAST_ACTIVE_THROTTLE_TTL,
      "NX",
    );
    if (ok !== "OK") return;

    await prisma.user.update({
      where: { id: userId },
      data: { lastActiveAt: new Date() },
    });
  } catch {
    /* ignore activity tracking failures */
  }
}
