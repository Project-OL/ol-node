import { z } from 'zod'
import { phoneSchema } from './schemas'

/** Admin PATCH of agency KYC contact (phone and/or email). Distinct from login auth identifiers. */
export const adminKycContactPatchSchema = z
  .object({
    phone: phoneSchema.optional(),
    email: z.string().trim().email().optional(),
  })
  .refine((d) => d.phone != null || d.email != null, {
    message: 'Provide at least phone or email',
  })

export type AdminKycContactPatchBody = z.infer<typeof adminKycContactPatchSchema>

const ADMIN_GOVT_ID_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const

/** Admin presign for replacing agency KYC government ID. Allowed even when the application is terminal. */
export const adminGovtIdUploadUrlSchema = z
  .object({
    mimeType: z.enum(ADMIN_GOVT_ID_MIME).default('image/jpeg'),
  })
  .strict()

export const adminGovtIdConfirmSchema = z
  .object({
    s3Key: z.string().min(1),
  })
  .strict()

export const agencyAdminListQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  country: z.string().min(2).max(8).optional(),
  q: z.string().max(255).optional(),
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
})

export const pendingApplicationsQuerySchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(100).default(20),
})

export const approveApplicationBodySchema = z.object({
  applicationId: z.string().uuid(),
  commissionTier: z.string().min(1).max(8).optional(),
})

export const rejectApplicationBodySchema = z.object({
  adminNote: z.string().max(500).optional(),
  userNote: z.string().max(500).optional(),
})

export const editCommissionTierBodySchema = z.object({
  commissionTier: z.string().min(1).max(8),
})

export const sendAgencyMessageBodySchema = z.object({
  message: z.string().min(1).max(4000),
})

/** User UUID or numeric public / display ID (`publicId`, `defaultPublicId`, `currentVipPublicId`). */
const hostIdentifierSchema = z.string().trim().min(1).max(64)

export const addHostBodySchema = z.object({
  hostUserId: hostIdentifierSchema,
})

export const transferHostsBodySchema = z.object({
  targetAgencyIdentifier: z.string().min(1).max(64),
  hostUserIds: z.array(hostIdentifierSchema).min(1).max(100),
})

export const suspendAgencyBodySchema = z
  .object({
    pausedUntil: z.string().datetime().optional(),
    suspendDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .refine((b) => b.pausedUntil != null || b.suspendDays != null, {
    message: 'Either pausedUntil or suspendDays is required',
  })

export const setAgencyPayrollBodySchema = z.object({
  payrollEnabled: z.boolean(),
})

export const banAgencyBodySchema = z.object({
  reason: z.string().max(1000).optional(),
})
