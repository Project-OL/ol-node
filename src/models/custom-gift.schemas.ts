import { z } from 'zod'

/** E.164-ish WhatsApp number: optional +, 8-15 digits. */
export const WhatsappNumberSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{8,15}$/, 'whatsappNumber must be 8-15 digits with optional leading +')

export const CreateCustomGiftRequestBodySchema = z.object({
  whatsappNumber: WhatsappNumberSchema,
  /** What the user wants (shown to the CS agent / admin). */
  note: z.string().trim().min(1).max(2000).optional(),
  /** Requested gift validity in days (CS uses when creating the catalog gift). */
  validityDays: z.number().int().min(1).max(3650).optional(),
  /** Stable client key: a network-timeout retry replays the original result instead of double-debiting. */
  idempotencyKey: z.string().min(8).max(128).optional(),
})

export const MyCustomGiftRequestsQuerySchema = z.object({
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().uuid().optional(),
})

export const AdminCustomGiftRequestListQuerySchema = z.object({
  status: z.enum(['PENDING', 'COMPLETED', 'FAILED']).optional(),
  userId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const UpdateCustomGiftConfigBodySchema = z
  .object({
    coinCost: z.coerce.bigint().min(1n).max(1_000_000_000n).optional(),
    enabled: z.boolean().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' })

export const CompleteCustomGiftRequestBodySchema = z.object({
  /** Gift created via the gift-admin endpoints for this user. */
  giftId: z.string().uuid().optional(),
  adminNote: z.string().trim().max(2000).optional(),
})

export const FailCustomGiftRequestBodySchema = z.object({
  reason: z.string().trim().min(1).max(2000),
  /** Admin decides whether the coin debit is returned. */
  refund: z.boolean(),
  adminNote: z.string().trim().max(2000).optional(),
})

export type CreateCustomGiftRequestBody = z.infer<typeof CreateCustomGiftRequestBodySchema>
export type AdminCustomGiftRequestListQuery = z.infer<typeof AdminCustomGiftRequestListQuerySchema>
export type UpdateCustomGiftConfigBody = z.infer<typeof UpdateCustomGiftConfigBodySchema>
export type CompleteCustomGiftRequestBody = z.infer<typeof CompleteCustomGiftRequestBodySchema>
export type FailCustomGiftRequestBody = z.infer<typeof FailCustomGiftRequestBodySchema>
