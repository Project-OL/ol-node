import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../../middlewares/auth.middleware";
import { LevelType } from "@prisma/client";
import { walletLevelService } from "../../services/user-level.service";

export async function walletLevelsRoutes(app: FastifyInstance) {
  app.get(
    "/wealth",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const [snapshot, table] = await Promise.all([
        walletLevelService.getSnapshot(userId, LevelType.WEALTH),
        walletLevelService.getLevelTable(LevelType.WEALTH),
      ]);
      return reply.send({
        snapshot,
        table: table.map((t) => ({
          level: t.level,
          threshold: t.threshold.toString(),
        })),
      });
    },
  );

  app.get(
    "/livestream",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const [snapshot, table] = await Promise.all([
        walletLevelService.getSnapshot(userId, LevelType.LIVESTREAM),
        walletLevelService.getLevelTable(LevelType.LIVESTREAM),
      ]);
      return reply.send({
        snapshot,
        table: table.map((t) => ({
          level: t.level,
          threshold: t.threshold.toString(),
        })),
      });
    },
  );

  app.get(
    "/both",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const [wealthSnap, streamSnap, wealthTable, streamTable] =
        await Promise.all([
          walletLevelService.getSnapshot(userId, LevelType.WEALTH),
          walletLevelService.getSnapshot(userId, LevelType.LIVESTREAM),
          walletLevelService.getLevelTable(LevelType.WEALTH),
          walletLevelService.getLevelTable(LevelType.LIVESTREAM),
        ]);
      return reply.send({
        wealth: {
          snapshot: wealthSnap,
          table: wealthTable.map((t) => ({
            level: t.level,
            threshold: t.threshold.toString(),
          })),
        },
        livestream: {
          snapshot: streamSnap,
          table: streamTable.map((t) => ({
            level: t.level,
            threshold: t.threshold.toString(),
          })),
        },
      });
    },
  );
}
