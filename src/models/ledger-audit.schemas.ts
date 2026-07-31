import { z } from 'zod'

export const ledgerAuditFlagListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'DISMISSED']).optional(),
  category: z.enum(['VIP', 'COIN', 'POINT', 'TRADING_COIN']).optional(),
  code: z.string().trim().min(1).max(64).optional(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  q: z.string().trim().min(1).max(255).optional(),
  qType: z.enum(['auto', 'userId', 'publicId', 'displayId']).default('auto'),
})

export const ledgerAuditFlagPatchBodySchema = z.object({
  status: z.enum(['ACKNOWLEDGED', 'DISMISSED', 'OPEN']),
  note: z.string().trim().max(2000).optional().nullable(),
})

export type LedgerAuditFlagListQuery = z.infer<typeof ledgerAuditFlagListQuerySchema>
export type LedgerAuditFlagPatchBody = z.infer<typeof ledgerAuditFlagPatchBodySchema>
