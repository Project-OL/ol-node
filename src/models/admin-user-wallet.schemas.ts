import { z } from 'zod'

const positiveAmountSchema = z
  .string()
  .regex(/^\d+$/, 'Amount must be a non-negative integer string')
  .refine((v) => BigInt(v) > 0n, 'Amount must be positive')

export const adminWalletAmountBodySchema = z.object({
  amount: positiveAmountSchema,
  description: z.string().max(500).optional(),
  idempotencyKey: z.string().max(128).optional(),
})

export const adminTransactionListQuerySchema = z.object({
  types: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v == null) return undefined
      return Array.isArray(v)
        ? v
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    }),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  direction: z.enum(['credit', 'debit']).optional(),
})

export const adminPostingSuspendBodySchema = z.object({
  suspendedUntil: z.string().datetime(),
})

export const adminPostWarnBodySchema = z.object({
  message: z.string().min(1).max(4000).optional(),
})

export const adminPostListQuerySchema = z.object({
  userId: z.string().uuid(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
