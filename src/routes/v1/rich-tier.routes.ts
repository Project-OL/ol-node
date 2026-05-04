import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimitRichRead } from "../../middlewares/rateLimitAuth";
import { userRepository } from "../../repositories/user.repository";
import { richTierService } from "../../services/rich-tier.service";
import { AppError } from "../../middlewares/errorHandler";

const rolloverBodySchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  force: z.boolean().optional(),
});

const recomputeBodySchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export async function richTierRoutes(app: FastifyInstance) {
  const readPre = [authenticate, rateLimitRichRead];

  app.get(
    "/me",
    { preHandler: readPre },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const data = await richTierService.getCurrentTierForUser(userId);
      return reply.send(data);
    },
  );

  app.get(
    "/config",
    { preHandler: readPre },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const tiers = await richTierService.getTierConfig();
      return reply.send({ tiers });
    },
  );

  app.get(
    "/history",
    { preHandler: readPre },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const q = request.query as Record<string, string | undefined>;
      const limit = q.limit != null ? Number(q.limit) : 20;
      const cursor = q.cursor ?? null;
      const data = await richTierService.getHistory(userId, {
        limit: Number.isFinite(limit) ? limit : 20,
        cursor,
      });
      return reply.send(data);
    },
  );

  app.get(
    "/users/:publicId",
    { preHandler: readPre },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const publicId = (request.params as { publicId: string }).publicId;
      const numericId = Number(publicId);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        throw new AppError(400, "Invalid public ID", "INVALID_PUBLIC_ID");
      }
      const user = await userRepository.findByPublicId(numericId);
      if (!user) {
        throw new AppError(404, "User not found", "USER_NOT_FOUND");
      }
      const data = await richTierService.getCurrentTierForUser(user.id);
      return reply.send(data);
    },
  );

  app.post(
    "/admin/rollover",
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = rolloverBodySchema.parse(request.body);
      await richTierService.enqueueMonthlyRolloverMaster(
        body.year,
        body.month,
        body.force,
      );
      return reply.send({ ok: true, enqueued: true });
    },
  );

  app.post(
    "/admin/recompute/:userId",
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.params as { userId: string }).userId;
      const body = recomputeBodySchema.parse(request.body);
      await richTierService.processMonthlyRolloverForUser(
        userId,
        body.year,
        body.month,
      );
      return reply.send({ ok: true });
    },
  );
}
