import { z } from 'zod'

const giftCode = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Code must be a lowercase slug')

const categorySlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Slug must be a lowercase slug')

export const GiftAdminListQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  status: z.enum(['active', 'disabled', 'all']).default('all'),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  search: z.string().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const CreateGiftCategoryBodySchema = z.object({
  name: z.string().min(1).max(255),
  slug: categorySlug.optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
})

export const UpdateGiftCategoryBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: categorySlug.optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
})

export const ReorderGiftCategoriesBodySchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
})

export const CreateGiftAdminBodySchema = z.object({
  name: z.string().min(1).max(255),
  code: giftCode.optional(),
  coinCost: z.coerce.number().int().positive(),
  displayImageUrl: z.string().url(),
  effectUrl: z.string().url().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
  vipOnly: z.coerce.boolean().optional(),
})

export const CreateGiftAdminMultipartFieldsSchema = z.object({
  name: z.string().min(1).max(255),
  code: giftCode.optional(),
  coinCost: z.coerce.number().int().positive(),
  displayImageUrl: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  effectUrl: z.union([z.literal(''), z.string().url()]).optional(),
  categoryId: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().uuid().nullable().optional(),
  ),
  displayOrder: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  vipOnly: z.preprocess((v) => {
    if (v === '' || v === undefined) return undefined
    if (v === 'true' || v === true) return true
    if (v === 'false' || v === false) return false
    return v
  }, z.boolean().optional()),
})

export const PatchGiftAdminBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: giftCode.optional(),
  coinCost: z.coerce.number().int().positive().optional(),
  displayImageUrl: z.string().url().optional(),
  effectUrl: z.string().url().nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
  vipOnly: z.boolean().optional(),
  isActive: z.boolean().optional(),
})

export const PatchGiftAdminMultipartFieldsSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  code: giftCode.optional(),
  coinCost: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  displayImageUrl: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  effectUrl: z.string().optional(),
  categoryId: z.preprocess(
    (v) => (v === '' ? null : v === undefined ? undefined : v),
    z.string().uuid().nullable().optional(),
  ),
  displayOrder: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  vipOnly: z.preprocess((v) => {
    if (v === '' || v === undefined) return undefined
    if (v === 'true' || v === true) return true
    if (v === 'false' || v === false) return false
    return v
  }, z.boolean().optional()),
  isActive: z.preprocess((v) => {
    if (v === '' || v === undefined) return undefined
    if (v === 'true' || v === true) return true
    if (v === 'false' || v === false) return false
    return v
  }, z.boolean().optional()),
})

export const GalleryPeriodQuerySchema = z.object({
  year: z.coerce.number().int().min(2024).max(2099).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})

export const CreateGalleryCategoryBodySchema = z.object({
  name: z.string().min(1).max(255),
  displayOrder: z.coerce.number().int().min(0).optional(),
  enabledAt: z.string().datetime().nullable().optional(),
  year: z.coerce.number().int().min(2024).max(2099).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})

export const UpdateGalleryCategoryBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
  enabledAt: z.string().datetime().nullable().optional(),
})

export const ReorderGalleryCategoriesBodySchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1),
  year: z.coerce.number().int().min(2024).max(2099).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
})

export const AddGiftsToGalleryCategoryBodySchema = z.object({
  giftIds: z.array(z.string().uuid()).min(1),
})
