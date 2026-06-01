import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { requireAgent } from "../../middlewares/requireAgent.middleware";
import { rateLimitAgencyDashboard } from "../../middlewares/rateLimitAuth";
import { AppError } from "../../middlewares/errorHandler";
import { agencyDashboardService } from "../../services/agencyDashboard.service";
import type { DashboardPeriodQuery } from "../../utils/datetime";

const preDashboard = [authenticate, requireAgent, rateLimitAgencyDashboard];

const dashboardPeriodSchema = z
  .object({
    period: z
      .enum(["TODAY", "YESTERDAY", "THIS_WEEK", "THIS_MONTH", "LAST_30_DAYS"])
      .optional(),
    from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

const hostListQuerySchema = dashboardPeriodSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
});

function parsePeriod(query: unknown): DashboardPeriodQuery {
  const parsed = dashboardPeriodSchema.safeParse(query ?? {});
  if (!parsed.success) {
    throw new AppError(
      400,
      parsed.error.errors[0]?.message ?? "Invalid query",
      "INVALID_REQUEST",
    );
  }
  return parsed.data;
}

/**
 * Agency agent dashboard — read-only earnings, commission and host analytics.
 * Mounted under `/api/v1/agency/dashboard` from `agency.routes.ts`.
 * All routes require `authenticate` + `requireAgent` (403 AGENT_ONLY otherwise).
 */
export async function registerAgencyDashboardRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/dashboard/earnings",
    { preHandler: preDashboard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const query = parsePeriod(request.query);
      const result = await agencyDashboardService.getEarningsOverview(userId, query);
      return reply.send(result);
    },
  );

  app.get(
    "/dashboard/host-summary",
    { preHandler: preDashboard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const query = parsePeriod(request.query);
      const result = await agencyDashboardService.getHostDataSummary(userId, query);
      return reply.send(result);
    },
  );

  app.get(
    "/dashboard/hosts",
    { preHandler: preDashboard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const parsed = hostListQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw new AppError(
          400,
          parsed.error.errors[0]?.message ?? "Invalid query",
          "INVALID_REQUEST",
        );
      }
      const result = await agencyDashboardService.getHostCommissionList(userId, parsed.data);
      return reply.send(result);
    },
  );

  app.get<{ Params: { hostUserId: string } }>(
    "/dashboard/hosts/:hostUserId",
    { preHandler: preDashboard },
    async (
      request: FastifyRequest<{ Params: { hostUserId: string } }>,
      reply: FastifyReply,
    ) => {
      const userId = request.userId!;
      const query = parsePeriod(request.query);
      const result = await agencyDashboardService.getHostDrilldown(
        userId,
        request.params.hostUserId,
        query,
      );
      return reply.send(result);
    },
  );

  app.get(
    "/dashboard/today",
    { preHandler: preDashboard },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId!;
      const result = await agencyDashboardService.getAgentEarnedToday(userId);
      return reply.send(result);
    },
  );
}
