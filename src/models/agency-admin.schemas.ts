import { z } from 'zod'

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

export const addHostBodySchema = z.object({
  hostUserId: z.string().uuid(),
})

export const transferHostsBodySchema = z.object({
  targetAgencyIdentifier: z.string().min(1).max(64),
  hostUserIds: z.array(z.string().uuid()).min(1).max(100),
})

export const suspendAgencyBodySchema = z
  .object({
    pausedUntil: z.string().datetime().optional(),
    suspendDays: z.coerce.number().int().min(1).max(365).optional(),
  })
  .refine((b) => b.pausedUntil != null || b.suspendDays != null, {
    message: 'Either pausedUntil or suspendDays is required',
  })
