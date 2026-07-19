import { z } from 'zod'

/**
 * Derived banner status — never stored. Precedence:
 * COMPLETED (past endAt) > STOPPED (manually disabled) > SCHEDULED (before startAt) > ACTIVE.
 */
export const BANNER_STATUSES = ['ACTIVE', 'SCHEDULED', 'COMPLETED', 'STOPPED'] as const
export type BannerStatus = (typeof BANNER_STATUSES)[number]

const IsoDate = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime())

export const BannerActiveQuerySchema = z.object({
  /** Free-text position filter (exact match, e.g. "home_top"). */
  position: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const CreateBannerBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    /** Public URL from POST /admin/banners/upload-url (or any absolute URL). */
    imageUrl: z.string().trim().url().max(2048),
    /** Free-text placement key the client interprets (e.g. "home_top", "recharge_page"). */
    position: z.string().trim().min(1).max(100),
    startAt: IsoDate,
    endAt: IsoDate.optional(),
    /** Alternative to endAt: endAt = startAt + validityDays. */
    validityDays: z.number().int().min(1).max(3650).optional(),
    enabled: z.boolean().optional().default(true),
  })
  .refine((b) => (b.endAt != null) !== (b.validityDays != null), {
    message: 'Provide exactly one of endAt or validityDays',
  })

export const PatchBannerBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    imageUrl: z.string().trim().url().max(2048).optional(),
    position: z.string().trim().min(1).max(100).optional(),
    startAt: IsoDate.optional(),
    endAt: IsoDate.optional(),
    /** Recomputes endAt from the effective startAt. */
    validityDays: z.number().int().min(1).max(3650).optional(),
    /** false = manual stop before endAt; true = re-enable. */
    enabled: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' })
  .refine((b) => !(b.endAt != null && b.validityDays != null), {
    message: 'Provide only one of endAt or validityDays',
  })

export const AdminBannerListQuerySchema = z.object({
  status: z.enum(['active', 'scheduled', 'completed', 'stopped', 'all']).default('all'),
  position: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const BannerUploadUrlBodySchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive().optional(),
})

export type CreateBannerBody = z.infer<typeof CreateBannerBodySchema>
export type PatchBannerBody = z.infer<typeof PatchBannerBodySchema>
export type AdminBannerListQuery = z.infer<typeof AdminBannerListQuerySchema>
