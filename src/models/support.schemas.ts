import { z } from 'zod'

// Upload
export const SupportUploadUrlSchema = z.object({
  folder: z.enum(['ticket', 'message']),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  ticketId: z.coerce.bigint().optional(), // required when folder = "message"
})

// Ticket creation
export const CreateTicketSchema = z.object({
  type: z.enum(['CONSULT', 'REPORT_COMPLAINTS', 'FEEDBACK', 'BUSINESS_COOPERATION']),
  subType: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  imageUrl: z.string().url().optional(),
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

// Query params
export const GetTicketsQuerySchema = z.object({
  status: z.enum(['OPEN', 'AWAITING_REPLY', 'CLOSED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const GetMessagesQuerySchema = z.object({
  cursor: z.coerce.bigint().optional(), // id of oldest message client already has
  limit: z.coerce.number().int().min(1).max(50).default(30),
})

export const GetAllTicketsQuerySchema = z.object({
  status: z.enum(['OPEN', 'AWAITING_REPLY', 'CLOSED']).optional(),
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
