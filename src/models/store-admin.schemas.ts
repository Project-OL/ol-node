import { z } from 'zod'
import { StoreItemCategory } from '@prisma/client'

export const StoreAdminListQuerySchema = z.object({
  category: z.nativeEnum(StoreItemCategory).optional(),
  status: z.enum(['active', 'disabled', 'all']).default('all'),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  search: z.string().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const CreateStoreAdminBodySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.nativeEnum(StoreItemCategory),
  coinCost: z.coerce.number().int().positive(),
  validityDays: z.coerce.number().int().positive().max(365).optional(),
  displayImageUrl: z.string().url(),
  effectUrl: z.string().url().nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
})

export const PatchStoreAdminBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  coinCost: z.coerce.number().int().positive().optional(),
  validityDays: z.coerce.number().int().positive().max(365).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
  displayImageUrl: z.string().url().optional(),
  effectUrl: z.string().url().nullable().optional(),
})

/** Form fields for multipart create (values are strings). */
export const CreateStoreAdminMultipartFieldsSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(2000).optional()),
  category: z.nativeEnum(StoreItemCategory),
  coinCost: z.coerce.number().int().positive(),
  validityDays: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().max(365).optional(),
  ),
  displayImageUrl: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  effectUrl: z.union([z.literal(''), z.string().url()]).optional(),
  sortOrder: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  isActive: z.preprocess((v) => {
    if (v === '' || v === undefined) return undefined
    if (v === 'true' || v === true) return true
    if (v === 'false' || v === false) return false
    return v
  }, z.boolean().optional()),
})

export const PatchStoreAdminMultipartFieldsSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  coinCost: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
  validityDays: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().positive().max(365).optional(),
  ),
  isActive: z.preprocess((v) => {
    if (v === '' || v === undefined) return undefined
    if (v === 'true' || v === true) return true
    if (v === 'false' || v === false) return false
    return v
  }, z.boolean().optional()),
  sortOrder: z.preprocess(
    (v) => (v === '' || v === undefined ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  displayImageUrl: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  effectUrl: z.string().optional(),
})
