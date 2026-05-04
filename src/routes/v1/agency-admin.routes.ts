import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { AppError } from "../../middlewares/errorHandler";
import { agencyService } from "../../services/agency.service";
import { agencyHostService } from "../../services/agencyHost.service";
import { agencyCommissionService } from "../../services/agencyCommission.service";

const ApproveSchema = z.object({
  ticketId: z.string().min(1),
});

const ForceExitSchema = z.object({
  ticketId: z.string().min(1),
  deductPoints: z.string().optional(),
  pauseAgency: z.boolean().optional(),
});

export default async function agencyAdminRoutes(app: FastifyInstance) {
  app.post<{ Params: { userId: string } }>(
    "/:userId/approve",
    { preHandler: [requireAdmin] },
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply,
    ) => {
      const adminUserId = request.userId;
      if (!adminUserId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = ApproveSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      let ticketId: bigint;
      try {
        ticketId = BigInt(parsed.data.ticketId);
      } catch {
        throw new AppError(400, "Invalid ticket id", "INVALID_REQUEST");
      }
      const result = await agencyService.createAgencyFromTicket({
        adminUserId,
        applicantUserId: request.params.userId,
        ticketId,
      });
      return reply.status(result.created ? 201 : 200).send({
        ok: true,
        created: result.created,
        agencyPublicId: result.agency.defaultPublicId.toString(),
      });
    },
  );

  app.post<{ Params: { userId: string } }>(
    "/:userId/unpause",
    { preHandler: [requireAdmin] },
    async (
      request: FastifyRequest<{ Params: { userId: string } }>,
      reply: FastifyReply,
    ) => {
      await agencyService.unpauseAgency(request.params.userId);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { hostUserId: string } }>(
    "/cs/host/:hostUserId/force-exit",
    { preHandler: [requireAdmin] },
    async (
      request: FastifyRequest<{ Params: { hostUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const csUserId = request.userId;
      if (!csUserId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = ForceExitSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      let ticketId: bigint;
      try {
        ticketId = BigInt(parsed.data.ticketId);
      } catch {
        throw new AppError(400, "Invalid ticket id", "INVALID_REQUEST");
      }
      let deductPoints: bigint | undefined;
      if (parsed.data.deductPoints != null && parsed.data.deductPoints !== "") {
        try {
          deductPoints = BigInt(parsed.data.deductPoints);
        } catch {
          throw new AppError(400, "Invalid deductPoints", "INVALID_REQUEST");
        }
      }
      await agencyHostService.forceExitFromCS({
        hostUserId: request.params.hostUserId,
        ticketId,
        deductPoints,
        pauseAgency: parsed.data.pauseAgency,
        csUserId,
      });
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { agencyUserId: string } }>(
    "/recompute/:agencyUserId",
    { preHandler: [requireAdmin] },
    async (
      request: FastifyRequest<{ Params: { agencyUserId: string } }>,
      reply: FastifyReply,
    ) => {
      await agencyCommissionService.recomputeAgencyLevel(
        request.params.agencyUserId,
        { skipDailyDedupe: true },
      );
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/recompute-master",
    { preHandler: [requireAdmin] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as Record<string, string | undefined>;
      const utcDate = q.utcDate?.trim() || undefined;
      await agencyCommissionService.enqueueDailyRecomputeMaster({
        utcDate,
        force: true,
      });
      return reply.send({ ok: true, enqueued: true });
    },
  );
}
