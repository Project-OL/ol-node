import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { withdrawalService } from "../../services/withdrawal.service";
import {
  rateLimitWithdrawalCreate,
  rateLimitWithdrawalDispute,
} from "../../middlewares/rateLimitAuth";
import { userRepository } from "../../repositories/user.repository";

const CreateSchema = z.object({
  grossPoints: z.coerce.bigint().positive(),
  paymentMethodId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
});

const DisputeSchema = z.object({
  description: z.string().max(2000).optional(),
});

const ProofUploadSchema = z.object({
  assignmentId: z.string().uuid(),
  mimeType: z.string().min(1).max(100),
});

export async function withdrawalRoutes(app: FastifyInstance) {
  app.post(
    "/",
    { preHandler: [authenticate, rateLimitWithdrawalCreate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = CreateSchema.parse(request.body ?? {});
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
      const body = ProofUploadSchema.parse(request.body ?? {});
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
      const row = await withdrawalService.getWithdrawalById(
        request.userId!,
        request.params.id,
      );
      return reply.send(row);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/:id/dispute",
    { preHandler: [authenticate, rateLimitWithdrawalDispute] },
    async (request, reply: FastifyReply) => {
      const body = DisputeSchema.parse(request.body ?? {});
      const result = await withdrawalService.raiseDispute(
        request.userId!,
        request.params.id,
        body.description,
      );
      return reply.send(result);
    },
  );
}
