import { z } from "zod";

const liveMimeEnum = z.enum(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

export const livePhotoUploadUrlBodySchema = z
  .object({
    mimeType: liveMimeEnum.optional().default("image/jpeg"),
  })
  .strict();

export const livePhotoVerifyBodySchema = z
  .object({
    s3Key: z.string().min(1),
  })
  .strict();

export type LivePhotoUploadUrlBody = z.infer<typeof livePhotoUploadUrlBodySchema>;
export type LivePhotoVerifyBody = z.infer<typeof livePhotoVerifyBodySchema>;
