import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { rateLimitAgencyPointTransfer } from "../../middlewares/rateLimitAuth";
import { agencyCommissionService } from "../../services/agencyCommission.service";
import { agencyRepository } from "../../repositories/agency.repository";
import { securityPasswordService } from "../../services/security-password.service";

const preAuth = [authenticate];

const TransferSchema = z.object({
  recipientAgentPublicId: z.string().min(1),
  points: z.string().min(1),
  /** Prefer header `X-Security-Password`; body field discouraged vs header. */
  securityPassword: z.string().optional(),
});

export async function registerAgencyCommissionRoutes(app: FastifyInstance) {
  app.get("/commission/config", async (_request: FastifyRequest, reply: FastifyReply) => {
    const rows = await agencyCommissionService.getLevelConfig();
    return reply.send({ levels: rows });
  });

  app.get(
    "/commission/me",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const owned = await agencyRepository.getAgencyByUserId(userId);
      if (!owned) {
        throw new AppError(403, "Agent only", "NOT_AN_AGENT");
      }
      const q = request.query as Record<string, string | undefined>;
      const periodDays = Math.min(
        365,
        Math.max(1, Number(q.periodDays ?? "30") || 30),
      );
      const snap = await agencyCommissionService.getCommissionMeSnapshot(
        userId,
        periodDays,
      );
      return reply.send(snap);
    },
  );

  app.get(
    "/commission/hosts",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const owned = await agencyRepository.getAgencyByUserId(userId);
      if (!owned) {
        throw new AppError(403, "Agent only", "NOT_AN_AGENT");
      }
      const q = request.query as Record<string, string | undefined>;
      const periodDays = Math.min(
        365,
        Math.max(1, Number(q.period ?? q.periodDays ?? "30") || 30),
      );
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? "20") || 20));
      const offset = Math.max(0, Number(q.cursor ?? "0") || 0);
      const result = await agencyCommissionService.listHostsByEarnings(
        userId,
        periodDays,
        { limit, offset },
      );
      return reply.send(result);
    },
  );

  app.get<{ Params: { hostUserId: string } }>(
    "/commission/host/:hostUserId",
    { preHandler: preAuth },
    async (request, reply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const owned = await agencyRepository.getAgencyByUserId(userId);
      if (!owned) {
        throw new AppError(403, "Agent only", "NOT_AN_AGENT");
      }
      const q = request.query as Record<string, string | undefined>;
      const periodDays = Math.min(
        365,
        Math.max(1, Number(q.period ?? "30") || 30),
      );
      const detail = await agencyCommissionService.getHostCommissionDetail(
        userId,
        request.params.hostUserId,
        periodDays,
      );
      return reply.send(detail);
    },
  );

  app.post(
    "/transfer-points",
    { preHandler: [...preAuth, rateLimitAgencyPointTransfer] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = TransferSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      let recipientPid: bigint;
      try {
        recipientPid = BigInt(parsed.data.recipientAgentPublicId.trim());
      } catch {
        throw new AppError(400, "Invalid recipientAgentPublicId", "INVALID_REQUEST");
      }
      let points: bigint;
      try {
        points = BigInt(parsed.data.points);
      } catch {
        throw new AppError(400, "Invalid points", "INVALID_REQUEST");
      }

      const securityPassword = String(
        request.headers["x-security-password"] ?? parsed.data.securityPassword ?? "",
      );
      await securityPasswordService.verifyCurrentPassword(userId, securityPassword);

      const recipientAgency = await agencyRepository.getAgencyByPublicId(recipientPid);
      if (!recipientAgency) {
        throw new AppError(400, "Recipient is not an agent", "INVALID_RECIPIENT");
      }

      const ts = Date.now();
      const idempotencyKey = `agent-point-transfer:${userId}:${ts}`;

      const result = await agencyCommissionService.transferPointsToAgent({
        senderAgentUserId: userId,
        recipientAgentUserId: recipientAgency.userId,
        points,
        idempotencyKey,
      });
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/transfer-points/history",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const q = request.query as Record<string, string | undefined>;
      const roleRaw = (q.role ?? "all").toLowerCase();
      const role =
        roleRaw === "sender" || roleRaw === "recipient" || roleRaw === "all"
          ? roleRaw
          : "all";
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? "20") || 20));
      const offset = Math.max(0, Number(q.cursor ?? "0") || 0);
      const { agencyPointTransferRepository } = await import(
        "../../repositories/agencyPointTransfer.repository"
      );
      const rows = await agencyPointTransferRepository.listForUser(userId, {
        role,
        limit,
        offset,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return reply.send({
        items: page.map((r) => ({
          id: r.id,
          senderAgentUserId: r.senderAgentUserId,
          recipientAgentUserId: r.recipientAgentUserId,
          points: r.points.toString(),
          createdAt: r.createdAt.toISOString(),
        })),
        nextCursor: hasMore ? String(offset + limit) : null,
      });
    },
  );
}
