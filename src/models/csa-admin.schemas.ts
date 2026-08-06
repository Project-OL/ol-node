import { z } from 'zod'
import { isValidExactIp, normalizeIp } from '../utils/ipAddress'

export const AdminStatusEnum = z.enum(['ACTIVE', 'DISABLED', 'SUSPENDED'])

const usernameSchema = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, digits, dot, underscore, hyphen')

/** Exact IPv4/IPv6; stored/compared in normalized form. */
export const ExactIpSchema = z
  .string()
  .min(3)
  .max(45)
  .refine((v) => isValidExactIp(v), { message: 'Must be a valid IPv4 or IPv6 address' })
  .transform((v) => normalizeIp(v)!)

export const CreateCsaSchema = z.object({
  name: z.string().min(2).max(100),
  username: usernameSchema,
  email: z.string().email(),
  password: z.string().min(12),
  phone: z.string().min(4).max(20),
  phoneCountryCode: z.string().min(1).max(8),
  gender: z.enum(['male', 'female', 'other']).optional(),
  country: z.string().min(2).max(100),
  /**
   * Exact IPs to seed on create (1–20). Optional for contract compatibility;
   * CSA login is blocked while the whitelist is empty.
   */
  allowedIps: z.array(ExactIpSchema).max(20).optional().default([]),
})
export type CreateCsaInput = z.infer<typeof CreateCsaSchema>

export const AddCsaIpSchema = z.object({
  ipAddress: ExactIpSchema,
})
export type AddCsaIpInput = z.infer<typeof AddCsaIpSchema>

export const CsaIpWhitelistIdParamsSchema = z.object({
  adminId: z.string().min(1),
  whitelistId: z.string().min(1),
})

export const UpdateCsaSchema = z
  .object({
    name: z.string().min(2).max(100).optional(),
    username: usernameSchema.optional(),
    phone: z.string().min(4).max(20).optional(),
    phoneCountryCode: z.string().min(1).max(8).optional(),
    gender: z.enum(['male', 'female', 'other']).nullable().optional(),
    country: z.string().min(2).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })
export type UpdateCsaInput = z.infer<typeof UpdateCsaSchema>

export const SetCsaStatusSchema = z.object({
  status: AdminStatusEnum,
})

export const ListCsasQuerySchema = z.object({
  status: AdminStatusEnum.optional(),
  country: z.string().max(100).optional(),
  search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListCsasQuery = z.infer<typeof ListCsasQuerySchema>

export const ExportCsasQuerySchema = z.object({
  status: AdminStatusEnum.optional(),
})

export const CsaIdParamsSchema = z.object({
  adminId: z.string().min(1),
})

/** CSAs with recent failed logins / active lockouts (SUPER_ADMIN). */
export const FailedLoginsQuerySchema = z.object({
  /** Only include rows whose lastFailedLoginAt is within this many hours (default 24). */
  withinHours: z.coerce.number().int().min(1).max(168).default(24),
  /** When true, also include currently locked accounts even if last failure is older. */
  includeLocked: z.coerce.boolean().default(true),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type FailedLoginsQuery = z.infer<typeof FailedLoginsQuerySchema>

/** Per-CSA ticket list (SUPER_ADMIN) — all tickets or CLOSED+rated filter. */
export const CsaTicketsQuerySchema = z.object({
  status: z
    .enum(['OPEN', 'AWAITING_REPLY', 'CLOSED', 'ASSIGNED', 'PENDING_REVIEW'])
    .optional(),
  /** When true, only CLOSED tickets that have a star rating. */
  ratedOnly: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type CsaTicketsQuery = z.infer<typeof CsaTicketsQuerySchema>
