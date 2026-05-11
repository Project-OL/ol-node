import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { agencyAgentApplicationService } from "../../services/agencyAgentApplication.service";
import { agencyKycService } from "../../services/agencyKyc.service";

/** Bucket comes from server `AWS_S3_BUCKET`; optional `s3Bucket` in body is ignored (legacy clients). */
const confirmSchema = z.object({
  s3Key: z.string().min(1),
  s3Bucket: z.string().min(1).optional(),
});
const contactSchema = z.object({ phone: z.string().min(3), email: z.string().email() });
const uploadSchema = z.object({ mimeType: z.string().min(3).default("image/jpeg") });

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
    const body = uploadSchema.parse(request.body ?? {});
    const data = await agencyKycService.getPresignedGovtIdUrl(userId, body.mimeType);
    return reply.send(data);
  });

  app.post("/govt-id/confirm", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    const body = confirmSchema.parse(request.body ?? {});
    await agencyKycService.confirmGovtIdUpload(userId, body.s3Key);
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
