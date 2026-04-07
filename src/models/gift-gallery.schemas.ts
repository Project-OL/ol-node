import { z } from "zod";

const sectionSchema = z.object({
  title: z.string().min(1).max(255),
  sortOrder: z.coerce.number().int().optional(),
  giftIds: z.array(z.string().uuid()).min(1),
});

export const UpsertGiftGalleryBodySchema = z.object({
  hostUserId: z.string().uuid(),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  sections: z.array(sectionSchema).min(1),
});
