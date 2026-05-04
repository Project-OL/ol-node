import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import {
  rateLimitAgencyAccept,
  rateLimitAgencyApply,
  rateLimitAgencyLeaveApply,
} from "../../middlewares/rateLimitAuth";
import { AppError } from "../../middlewares/errorHandler";
import { agencyService } from "../../services/agency.service";
import { agencyHostService } from "../../services/agencyHost.service";
import { agencyRankingService } from "../../services/agencyRanking.service";
import { agencyApplicationRepository } from "../../repositories/agencyApplication.repository";
import { agencyLeaveApplicationRepository } from "../../repositories/agencyLeaveApplication.repository";
import { agencyHostRepository } from "../../repositories/agencyHost.repository";
import { registerAgencyCommissionRoutes } from "./agency-commission.routes";

const preAuth = [authenticate];

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

export default async function agencyRoutes(app: FastifyInstance) {
  await registerAgencyCommissionRoutes(app);

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
            ? {
                agencyPublicId:
                  view.hostMembership.agency.defaultPublicId.toString(),
                agencyDisplayName: view.hostMembership.agency.displayName,
                joinedAt: view.hostMembership.joinedAt.toISOString(),
                pendingLeaveApplication: pendingLeave
                  ? {
                      id: pendingLeave.id,
                      autoApproveAt: pendingLeave.autoApproveAt.toISOString(),
                    }
                  : undefined,
              }
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
      await agencyHostService.applyToAgency(
        userId,
        parsed.data.agencyPublicId,
        parsed.data.message,
      );
      return reply.status(201).send({ ok: true });
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
      await agencyHostService.cancelApplication(userId, request.params.id);
      return reply.status(204).send();
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

  app.get(
    "/applications/inbox",
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
      const status = q.status as
        | import("@prisma/client").AgencyApplicationStatus
        | undefined;
      const rows = await agencyApplicationRepository.listInbox(agencyRow.userId, {
        status,
        limit,
        cursor,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && page.length > 0
          ? `${page[page.length - 1]!.createdAt.toISOString()}|${page[page.length - 1]!.id}`
          : null;
      return reply.send({
        items: page.map((r) => ({
          id: r.id,
          hostUserId: r.hostUserId,
          status: r.status,
          message: r.message,
          createdAt: r.createdAt.toISOString(),
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
        })),
        nextCursor,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/applications/:id/accept",
    {
      preHandler: [...preAuth, rateLimitAgencyAccept],
    },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await agencyHostService.acceptApplication(userId, request.params.id);
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/applications/:id/reject",
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
      await agencyHostService.rejectApplication(
        userId,
        request.params.id,
        parsed.data.reason,
      );
      return reply.send({ ok: true });
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

  app.delete<{ Params: { id: string } }>(
    "/leave-applications/:id",
    { preHandler: preAuth },
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await agencyHostService.cancelLeaveApplication(userId, request.params.id);
      return reply.status(204).send();
    },
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
      const rows = await agencyLeaveApplicationRepository.listInbox(
        agencyRow.userId,
        {
          limit,
          cursor,
        },
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && page.length > 0
          ? `${page[page.length - 1]!.createdAt.toISOString()}|${page[page.length - 1]!.id}`
          : null;
      return reply.send({
        items: page.map((r) => ({
          id: r.id,
          hostUserId: r.hostUserId,
          status: r.status,
          reason: r.reason,
          createdAt: r.createdAt.toISOString(),
          autoApproveAt: r.autoApproveAt.toISOString(),
          lateApproveUntil: r.lateApproveUntil?.toISOString() ?? null,
        })),
        nextCursor,
      });
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
      const rows = await agencyHostRepository.listHosts(agencyRow.userId, {
        limit,
        cursor,
      });
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && page.length > 0
          ? `${page[page.length - 1]!.joinedAt.toISOString()}|${page[page.length - 1]!.hostUserId}`
          : null;
      return reply.send({
        items: page.map((r) => ({
          hostUserId: r.hostUserId,
          joinedAt: r.joinedAt.toISOString(),
        })),
        nextCursor,
      });
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
      ]);
      if (reserved.has(publicId)) {
        throw new AppError(400, "Invalid path", "INVALID_REQUEST");
      }
      const ag = await agencyService.getAgencyByPublicIdString(publicId);
      if (!ag) {
        throw new AppError(404, "Agency not found", "AGENCY_NOT_FOUND");
      }
      return reply.send({
        agencyPublicId: ag.defaultPublicId.toString(),
        displayName: ag.displayName,
        totalHostsCount: ag.totalHostsCount,
        currentLevel: ag.currentLevel,
        paused: ag.pausedAt != null,
      });
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
