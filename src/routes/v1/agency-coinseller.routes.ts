import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authenticate } from "../../middlewares/auth.middleware";
import { AppError } from "../../middlewares/errorHandler";
import { agencyCoinsellerService } from "../../services/agencyCoinseller.service";
import { agencyService } from "../../services/agency.service";
import { userRepository } from "../../repositories/user.repository";

const UpdateSettingsSchema = z.object({
  transferChannel: z.enum(["BANK", "EPAY"]).optional(),
  whatsappNumber: z
    .string()
    .regex(/^\+[1-9]\d{6,19}$/)
    .nullable()
    .optional(),
  autoReply: z.string().max(100).nullable().optional(),
});

const UploadUrlSchema = z
  .object({
    mimeType: z.string().optional(),
  })
  .strict();

const ConfirmImageSchema = z
  .object({
    s3Key: z.string().min(1),
  })
  .strict();

export default async function agencyCoinsellerRoutes(app: FastifyInstance) {
  app.get("/settings", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    await assertAgent(userId);
    const settings = await agencyCoinsellerService.getSettings(userId);
    const priceImageUrl = agencyCoinsellerService.getPriceImageUrl(settings.priceImageS3Key);
    return reply.send({ ...settings, priceImageUrl });
  });

  app.put("/settings", { preHandler: [authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.userId;
    if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
    await assertAgent(userId);
    const body = UpdateSettingsSchema.parse(request.body ?? {});
    const row = await agencyCoinsellerService.updateSettings(userId, body);
    await agencyService.bustRankingCache();
    const priceImageUrl = agencyCoinsellerService.getPriceImageUrl(row.priceImageS3Key);
    return reply.send({ ...row, priceImageUrl });
  });

  app.post(
    "/price-image/upload-url",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await assertAgent(userId);
      const body = UploadUrlSchema.parse(request.body ?? {});
      const result = await agencyCoinsellerService.getPriceImageUploadUrl(userId, body.mimeType);
      return reply.code(200).send(result);
    },
  );

  app.post(
    "/price-image/confirm",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await assertAgent(userId);
      const { s3Key } = ConfirmImageSchema.parse(request.body ?? {});
      const row = await agencyCoinsellerService.confirmPriceImage(userId, s3Key);
      await agencyService.bustRankingCache();
      const priceImageUrl = agencyCoinsellerService.getPriceImageUrl(row.priceImageS3Key);
      return reply.send({ ok: true, priceImageUrl });
    },
  );

  app.delete(
    "/price-image",
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.userId;
      if (!userId) throw new AppError(401, "Unauthorized", "UNAUTHORIZED");
      await assertAgent(userId);
      await agencyCoinsellerService.deletePriceImage(userId);
      await agencyService.bustRankingCache();
      return reply.send({ ok: true });
    },
  );
}

async function assertAgent(userId: string) {
  const user = await userRepository.findById(userId);
  if (!user?.isAgent) {
    throw new AppError(403, "Only agency agents can access coinseller settings", "AGENT_ONLY");
  }
}
