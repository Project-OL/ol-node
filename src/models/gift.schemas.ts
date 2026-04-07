import { z } from "zod";

const slugTag = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "Tag must be a lowercase slug");

export const CreateGiftBodySchema = z.object({
  name: z.string().min(1).max(255),
  coinCost: z.coerce.number().int().positive(),
  displayImageUrl: z.string().url(),
  effectUrl: z.string().url().optional(),
  tags: z.array(slugTag).optional(),
});

export const PatchGiftBodySchema = CreateGiftBodySchema.partial().extend({
  isActive: z.boolean().optional(),
  tags: z.array(slugTag).optional(),
});

export const GiftListQuerySchema = z.object({
  tag: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const SendGiftBodySchema = z.object({
  receiverUserId: z.string().uuid(),
  giftId: z.string().uuid(),
  context: z.enum(["direct", "livestream"]),
});
