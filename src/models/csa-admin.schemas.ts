import { z } from 'zod'

export const AdminStatusEnum = z.enum(['ACTIVE', 'DISABLED', 'SUSPENDED'])

const usernameSchema = z
  .string()
  .min(3)
  .max(50)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may only contain letters, digits, dot, underscore, hyphen')

export const CreateCsaSchema = z.object({
  name: z.string().min(2).max(100),
  username: usernameSchema,
  email: z.string().email(),
  password: z.string().min(12),
  phone: z.string().min(4).max(20),
  phoneCountryCode: z.string().min(1).max(8),
  gender: z.enum(['male', 'female', 'other']).optional(),
  country: z.string().min(2).max(100),
})
export type CreateCsaInput = z.infer<typeof CreateCsaSchema>

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
