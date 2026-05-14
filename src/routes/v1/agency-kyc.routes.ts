import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { agencyAgentApplicationService } from "../../services/agencyAgentApplication.service";
import { agencyKycService } from "../../services/agencyKyc.service";

/** Strict: only `s3Key`. Bucket is always server `AWS_S3_BUCKET` (never accepted from clients). */
const confirmSchema = z
  .object({
    s3Key: z.string().min(1),
  })
  .strict();

const contactSchema = z.object({ phone: z.string().min(3), email: z.string().email() });
const uploadSchema = z
  .object({
    mimeType: z.string().min(3).default("image/jpeg"),
  })
  .strict();

export default async function agencyKycRoutes(app: FastifyInstance) {
  app.post("/apply", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const result = await agencyAgentApplicationService.applyOrGet(userId);
    return reply.status(result.created ? 201 : 200).send({
      created: result.created,
      application: result.application,
    });
  });

  app.get("/application", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const data = await agencyAgentApplicationService.getMyApplication(userId);
    return reply.send(data);
  });

  app.post("/govt-id/upload-url", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const parsed = uploadSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors[0]?.message ?? "Invalid body",
        "INVALID_REQUEST",
      );
    }
    const data = await agencyKycService.getPresignedGovtIdUrl(userId, parsed.data.mimeType);
    return reply.send(data);
  });

  app.post("/govt-id/confirm", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const parsed = confirmSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors[0]?.message ?? "Invalid body",
        "INVALID_REQUEST",
      );
    }
    await agencyKycService.confirmGovtIdUpload(userId, parsed.data.s3Key);
    return reply.send({ ok: true });
  });

  app.put("/contact", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const body = contactSchema.parse(request.body ?? {});
    await agencyKycService.submitContactInfo(userId, body);
    return reply.send({ ok: true });
  });

  app.get("/status", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const data = await agencyKycService.getKycStatusForAdmin(userId);
    return reply.send(data);
  });
}
