import { z } from 'zod'

// Upload
export const SupportUploadUrlSchema = z.object({
  folder: z.enum(['ticket', 'message']),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  ticketId: z.coerce.bigint().optional(), // required when folder = "message"
})

// Transaction reference for payment-conflict tickets
export const TransactionRefSchema = z.object({
  refType: z.enum(['WITHDRAWAL', 'POINT_TRANSFER', 'COIN_TRANSFER', 'LEDGER_ENTRY']),
  refId: z.string().min(1).max(120),
})

/** SubTypes that must carry a transaction reference. */
const TRANSACTION_REF_REQUIRED_SUBTYPES = new Set(['POINT_TRANSFER_CONFLICT', 'COIN_TRANSFER_CONFLICT'])

// Ticket creation
export const CreateTicketSchema = z
  .object({
    type: z.enum(['CONSULT', 'REPORT_COMPLAINTS', 'FEEDBACK', 'BUSINESS_COOPERATION']),
    subType: z.string().min(1).max(100),
    description: z.string().min(1).max(2000),
    imageUrl: z.string().url().optional(),
    transactionRef: TransactionRefSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (TRANSACTION_REF_REQUIRED_SUBTYPES.has(val.subType) && !val.transactionRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transactionRef'],
        message: `transactionRef is required for subType ${val.subType}`,
      })
    }
  })

// Message
export const SendMessageSchema = z.object({
  content: z.string().min(1).max(2000),
  imageUrl: z.string().url().optional(),
})

// Rating
export const RateTicketSchema = z.object({
  rating: z.number().int().min(1).max(5),
})

// Query params (status list is additive: ASSIGNED / PENDING_REVIEW are new lifecycle states)
export const GetTicketsQuerySchema = z.object({
  status: z.enum(['OPEN', 'AWAITING_REPLY', 'CLOSED', 'ASSIGNED', 'PENDING_REVIEW']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const GetMessagesQuerySchema = z.object({
  cursor: z.coerce.bigint().optional(), // id of oldest message client already has
  limit: z.coerce.number().int().min(1).max(50).default(30),
})

export const GetAllTicketsQuerySchema = z.object({
  status: z.enum(['OPEN', 'AWAITING_REPLY', 'CLOSED', 'ASSIGNED', 'PENDING_REVIEW']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export type SupportUploadUrlInput = z.infer<typeof SupportUploadUrlSchema>
export type CreateTicketInput = z.infer<typeof CreateTicketSchema>
export type SendMessageInput = z.infer<typeof SendMessageSchema>
export type RateTicketInput = z.infer<typeof RateTicketSchema>
export type GetTicketsQuery = z.infer<typeof GetTicketsQuerySchema>
export type GetMessagesQuery = z.infer<typeof GetMessagesQuerySchema>
export type GetAllTicketsQuery = z.infer<typeof GetAllTicketsQuerySchema>
