import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { withdrawalService } from "../../services/withdrawal.service";
import { withdrawalPayoutRailConfigService } from "../../services/withdrawalPayoutRailConfig.service";
import {
  rateLimitWithdrawalCreate,
  rateLimitWithdrawalDispute,
} from "../../middlewares/rateLimitAuth";
import { userRepository } from "../../repositories/user.repository";
import {
  CreateWithdrawalSchema,
  DisputeWithdrawalSchema,
  DisputeEvidenceUrlSchema,
} from "../../models/withdrawal.schemas";

const ProofUploadBodySchema = z.object({
  assignmentId: z.string().uuid(),
  mimeType: z.string().min(1).max(100),
});

export async function withdrawalRoutes(app: FastifyInstance) {
  app.get("/payout-rails", async (_request, reply: FastifyReply) => {
    const config = await withdrawalPayoutRailConfigService.getPublicConfig();
    return reply.send(config);
  });

  app.post(
    "/",
    { preHandler: [authenticate, rateLimitWithdrawalCreate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateWithdrawalSchema.parse(request.body ?? {});
      const result = await withdrawalService.createWithdrawal(request.userId!, body);
      return reply.status(201).send(result);
    },
  );

  app.get(
    "/",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const limit = Math.min(
        50,
        Math.max(1, Number((request.query as { limit?: string }).limit) || 20),
      );
      const cursor = (request.query as { cursor?: string }).cursor;
      const result = await withdrawalService.getWithdrawalHistory(request.userId!, {
        limit,
        cursor,
      });
      return reply.send(result);
    },
  );

  app.post(
    "/proof-upload-url",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const u = await userRepository.findById(request.userId!);
      if (!u?.isAgent) {
        throw new AppError(403, "Agent only", "AGENT_ONLY");
      }
      const body = ProofUploadBodySchema.parse(request.body ?? {});
      const result = await withdrawalService.getPresignedProofUrl(
        request.userId!,
        body.assignmentId,
        body.mimeType,
      );
      return reply.send(result);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/:id",
    { preHandler: [authenticate] },
    async (request, reply: FastifyReply) => {
      const detail = await withdrawalService.getWithdrawalDetail(
        request.params.id,
        request.userId!,
      );
      return reply.send(detail);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/dispute-evidence-url",
    { preHandler: [authenticate] },
    async (request, reply: FastifyReply) => {
      const body = DisputeEvidenceUrlSchema.parse(request.body ?? {});
      const result = await withdrawalService.createDisputeEvidenceUploadUrl(
        request.params.id,
        request.userId!,
        body.mimeType,
      );
      return reply.send(result);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/dispute",
    { preHandler: [authenticate, rateLimitWithdrawalDispute] },
    async (request, reply: FastifyReply) => {
      const body = DisputeWithdrawalSchema.parse(request.body ?? {});
      const result = await withdrawalService.disputeWithdrawal(
        request.userId!,
        request.params.id,
        body,
      );
      return reply.send(result);
    },
  );
}
