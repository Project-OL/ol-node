import { z } from 'zod'

const sectionSchema = z.object({
  name: z.string().min(1).max(255),
  sortOrder: z.coerce.number().int().optional(),
  giftIds: z.array(z.string().uuid()).min(1),
})

export const UpsertGiftGalleryBodySchema = z.object({
  year: z.coerce.number().int().min(2024).max(2099),
  month: z.coerce.number().int().min(1).max(12),
  sections: z.array(sectionSchema).min(1),
})
