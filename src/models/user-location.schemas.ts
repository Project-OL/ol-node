import { z } from 'zod'

export const reportLocationBodySchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).optional().nullable(),
  source: z.string().min(1).max(40).optional(),
  recordedAt: z.string().datetime().optional(),
})

export type ReportLocationBody = z.infer<typeof reportLocationBodySchema>

export const locationHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
})

export const adminLocationsQuerySchema = z.object({
  userId: z.string().uuid().optional(),
  /** Numeric public / display ID (`publicId`, `defaultPublicId`, or `currentVipPublicId`). */
  publicId: z
    .string()
    .trim()
    .regex(/^\d+$/)
    .optional()
    .transform((v) => (v ? BigInt(v) : undefined)),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
})

export type AdminLocationsQuery = z.infer<typeof adminLocationsQuerySchema>
