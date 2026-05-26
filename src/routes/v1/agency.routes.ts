import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { requireAgent } from "../../middlewares/requireAgent.middleware";
import {
  rateLimitAgencyApply,
  rateLimitAgencyLeaveApply,
} from "../../middlewares/rateLimitAuth";
import { AppError } from "../../middlewares/errorHandler";
import {
  agencyService,
  mapHostAgencyMeBlock,
} from "../../services/agency.service";
import { agencyHostService } from "../../services/agencyHost.service";
import { agencyRankingService } from "../../services/agencyRanking.service";
import { agencyKycService } from "../../services/agencyKyc.service";
import { agencyRepository } from "../../repositories/agency.repository";
import { redisClient, RedisKeys } from "../../config/redis";
import { agencyLeaveApplicationRepository } from "../../repositories/agencyLeaveApplication.repository";
import { registerAgencyCommissionRoutes } from "./agency-commission.routes";
import { withdrawalService } from "../../services/withdrawal.service";
import { auditService } from "../../services/audit.service";
import { userRepository } from "../../repositories/user.repository";
import {
  rateLimitPayrollComplete,
  rateLimitPayrollReject,
} from "../../middlewares/rateLimitAuth";

const PayrollCompleteSchema = z.object({
  proofS3Key: z.string().min(1),
  proofS3Bucket: z.string().min(1),
});

const PayrollRejectSchema = z.object({
  reason: z.string().max(2000).optional(),
});

const PayrollInboxQuerySchema = z.object({
  status: z.enum(["PENDING", "COMPLETED"]).default("PENDING"),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

const preAuth = [authenticate];
const preAgent = [authenticate, requireAgent];

const ApplySchema = z.object({
  agencyPublicId: z.string().min(1),
  message: z.string().max(2000).optional(),
});

const RejectSchema = z.object({
  reason: z.string().max(2000).optional(),
});

const LeaveSchema = z.object({
  reason: z.string().max(2000).optional(),
});

const SettingsSchema = z.object({
  payrollEnabled: z.boolean().optional(),
});

const HostTagSchema = z.object({
  isTagged: z.boolean(),
});

const UpdateContactSchema = z
  .object({
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,19}$/)
      .optional(),
    email: z.string().email().optional(),
  })
  .refine((d) => d.phone || d.email, { message: "Provide at least phone or email" });

export default async function agencyRoutes(app: FastifyInstance) {
  await registerAgencyCommissionRoutes(app);

  app.put("/contact", { preHandler: preAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const user = await userRepository.findById(userId);
    if (!user?.isAgent) throw new AppError(403, "Agent only", "AGENT_ONLY");
    const body = UpdateContactSchema.parse(request.body ?? {});
    await agencyKycService.updateAgentContact(userId, body);
    const agency = await agencyRepository.getAgencyByUserId(userId);
    if (agency) {
      await redisClient.del(RedisKeys.agencyByPublicId(agency.defaultPublicId.toString()));
    }
    await agencyService.bustRankingCache();
    return reply.send({ ok: true });
  });

  app.get(
    "/me",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const view = await agencyService.getMyAgency(userId);
      const pendingLeave = await agencyLeaveApplicationRepository.getPendingForHost(
        userId,
      );
      return reply.send({
        owned: view.owned
          ? {
              agencyPublicId: view.owned.defaultPublicId.toString(),
              displayName: view.owned.displayName,
              avatarUrl: view.ownedAvatarUrl,
              totalHostsCount: view.owned.totalHostsCount,
              currentLevel: view.owned.currentLevel,
              payrollEnabled: view.owned.payrollEnabled,
              paused: view.owned.pausedAt != null,
              pendingJoinApplications: view.pendingJoinInbox,
              pendingLeaveApplications: view.pendingLeaveInbox,
            }
          : null,
        host:
          view.hostMembership != null
            ? mapHostAgencyMeBlock(view.hostMembership, pendingLeave)
            : null,
      });
    },
  );

  app.get(
    "/ranking",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const q = request.query as Record<string, string | undefined>;
      const periodRaw = (q.period ?? "ALL_TIME").toUpperCase();
      const period =
        periodRaw === "DAILY" ||
        periodRaw === "WEEKLY" ||
        periodRaw === "MONTHLY" ||
        periodRaw === "ALL_TIME"
          ? periodRaw
          : "ALL_TIME";
      const limit = Math.min(
        100,
        Math.max(1, Number(q.limit ?? "20") || 20),
      );
      const cursor = q.cursor ?? undefined;
      const result = await agencyRankingService.getRanking({
        period,
        limit,
        cursor,
      });
      return reply.send(result);
    },
  );

  app.post(
    "/applications",
    {
      preHandler: [...preAuth, rateLimitAgencyApply],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = ApplySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      const result = await agencyHostService.applyToAgency(
        userId,
        parsed.data.agencyPublicId,
        parsed.data.message,
      );
      return reply.status(201).send(result);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/applications/:id",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const { prismaRead } = await import("../../config/database");
      const app = await prismaRead.agencyHostApplication.findUnique({
        where: { id: request.params.id },
      });
      if (!app || app.hostUserId !== userId) {
        throw new AppError(404, "Application not found", "NOT_FOUND");
      }
      if (app.status === "ACCEPTED") {
        throw new AppError(
          409,
          "Cannot cancel an accepted application",
          "INVALID_STATE",
        );
      }
      if (app.status === "PENDING") {
        await agencyHostService.cancelApplication(userId, request.params.id);
        return reply.status(204).send();
      }
      throw new AppError(
        410,
        "Join applications are instant; cancel is no longer supported",
        "JOIN_CANCEL_DEPRECATED",
      );
    },
  );

  app.get(
    "/applications/me",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const q = request.query as Record<string, string | undefined>;
      const status = q.status as
        | "PENDING"
        | "ACCEPTED"
        | "REJECTED"
        | "CANCELLED"
        | undefined;
      const apps = await prismaReadFallbackApplications(userId, status);
      return reply.send({
        items: apps.map((r) => ({
          id: r.id,
          agencyUserId: r.agencyUserId,
          status: r.status,
          message: r.message,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.post(
    "/leave-applications",
    {
      preHandler: [...preAuth, rateLimitAgencyLeaveApply],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = LeaveSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      const result = await agencyHostService.applyToLeave(userId, parsed.data.reason);
      return reply.status(201).send(result);
    },
  );

  const cancelLeaveApplicationHandler = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const result = await agencyHostService.cancelLeaveApplication(
      userId,
      request.params.id,
    );
    return reply.send(result);
  };

  app.delete<{ Params: { id: string } }>(
    "/leave-applications/:id",
    { preHandler: preAuth },
    cancelLeaveApplicationHandler,
  );

  app.post<{ Params: { id: string } }>(
    "/leave-applications/:id/cancel",
    { preHandler: preAuth },
    cancelLeaveApplicationHandler,
  );

  app.get(
    "/leave-applications/me",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const rows = await prismaReadLeaveMine(userId);
      return reply.send({ items: rows });
    },
  );

  app.get(
    "/leave-applications/inbox",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const agencyRow = await agencyService.getAgencyByOwnerId(userId);
      if (!agencyRow) {
        throw new AppError(403, "Not an agency owner", "FORBIDDEN");
      }
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(50, Math.max(1, Number(q.limit ?? "20") || 20));
      const cursor = q.cursor ?? undefined;
      const result = await agencyHostService.listLeaveApplicationsInbox(
        agencyRow.userId,
        { limit, cursor },
      );
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/leave-applications/:id/accept",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await agencyHostService.acceptLeaveApplication(userId, request.params.id);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/leave-applications/:id/reject",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = RejectSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      const result = await agencyHostService.rejectLeaveApplication(
        userId,
        request.params.id,
        parsed.data.reason,
      );
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/leave-applications/:id/late-accept",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await agencyHostService.lateAcceptLeaveApplication(userId, request.params.id);
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/hosts",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const agencyRow = await agencyService.getAgencyByOwnerId(userId);
      if (!agencyRow) {
        throw new AppError(403, "Not an agency owner", "FORBIDDEN");
      }
      const q = request.query as Record<string, string | undefined>;
      const limit = Math.min(100, Math.max(1, Number(q.limit ?? "20") || 20));
      const cursor = q.cursor ?? undefined;
      const result = await agencyHostService.listHosts(agencyRow.userId, {
        limit,
        cursor,
      });
      return reply.send(result);
    },
  );

  app.patch<{ Params: { hostUserId: string } }>(
    "/hosts/:hostUserId/tag",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { hostUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = HostTagSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      const result = await agencyHostService.setHostTagged(
        userId,
        request.params.hostUserId,
        parsed.data.isTagged,
      );
      return reply.send(result);
    },
  );

  app.post<{ Params: { hostUserId: string } }>(
    "/hosts/:hostUserId/remove",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { hostUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await agencyHostService.removeHost(userId, request.params.hostUserId);
      return reply.send({ ok: true });
    },
  );

  app.patch(
    "/settings",
    { preHandler: preAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      const parsed = SettingsSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid body",
          "INVALID_REQUEST",
        );
      }
      if (parsed.data.payrollEnabled === undefined) {
        throw new AppError(400, "Nothing to update", "INVALID_REQUEST");
      }
      const agencyRow = await agencyService.getAgencyByOwnerId(userId);
      if (!agencyRow) {
        throw new AppError(403, "Not an agency owner", "FORBIDDEN");
      }
      await agencyService.setPayrollEnabled(userId, parsed.data.payrollEnabled);
      return reply.send({ ok: true, payrollEnabled: parsed.data.payrollEnabled });
    },
  );

  app.get(
    "/payroll/summary",
    { preHandler: preAgent },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const summary = await agencyService.getPayrollSummary(userId);
      return reply.send(summary);
    },
  );

  app.get(
    "/payroll/inbox",
    { preHandler: preAgent },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const query = PayrollInboxQuerySchema.parse(request.query ?? {});
      const result = await withdrawalService.getAgentPayrollInbox(
        userId,
        query.status,
        query.cursor,
        query.limit,
      );
      return reply.send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/payroll/assignments/:id",
    { preHandler: preAgent },
    async (request, reply: FastifyReply) => {
      const userId = request.userId!;
      const detail = await agencyService.getAssignmentDetail(
        request.params.id,
        userId,
      );
      if (
        detail.status === "PENDING" &&
        detail.slaRemainingSeconds > 0
      ) {
        auditService.log({
          userId,
          actionType: "PAYROLL_PII_ACCESS",
          actionStatus: "success",
          actionDetails: {
            assignmentId: detail.id,
          },
        });
      }
      return reply.send(detail);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/payroll/assignments/:id/complete",
    { preHandler: [...preAgent, rateLimitPayrollComplete] },
    async (request, reply: FastifyReply) => {
      const userId = request.userId!;
      const body = PayrollCompleteSchema.parse(request.body ?? {});
      const result = await withdrawalService.agentCompletePayroll(
        userId,
        request.params.id,
        body,
      );
      return reply.send({ ok: true, agentRewardPoints: result.agentRewardPoints });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/payroll/assignments/:id/reject",
    { preHandler: [...preAgent, rateLimitPayrollReject] },
    async (request, reply: FastifyReply) => {
      const userId = request.userId!;
      const body = PayrollRejectSchema.parse(request.body ?? {});
      await withdrawalService.agentRejectPayroll(
        userId,
        request.params.id,
        body.reason,
      );
      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: { publicId: string } }>(
    "/:publicId",
    async (
      request: FastifyRequest<{ Params: { publicId: string } }>,
      reply: FastifyReply,
    ) => {
      const { publicId } = request.params;
      const reserved = new Set([
        "me",
        "ranking",
        "applications",
        "leave-applications",
        "hosts",
        "settings",
        "commission",
        "transfer-points",
        "payroll",
      ]);
      if (reserved.has(publicId)) {
        throw new AppError(400, "Invalid path", "INVALID_REQUEST");
      }
      const profile = await agencyRankingService.getAgencyPublicProfile(publicId);
      if (!profile) {
        throw new AppError(404, "Agency not found", "AGENCY_NOT_FOUND");
      }
      return reply.send(profile);
    },
  );
}

async function prismaReadFallbackApplications(
  userId: string,
  status?: "PENDING" | "ACCEPTED" | "REJECTED" | "CANCELLED",
) {
  const { prismaRead } = await import("../../config/database");
  return prismaRead.agencyHostApplication.findMany({
    where: {
      hostUserId: userId,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

async function prismaReadLeaveMine(userId: string) {
  const { prismaRead } = await import("../../config/database");
  const rows = await prismaRead.agencyLeaveApplication.findMany({
    where: { hostUserId: userId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    autoApproveAt: r.autoApproveAt.toISOString(),
    lateApproveUntil: r.lateApproveUntil?.toISOString() ?? null,
  }));
}
