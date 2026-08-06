import { z } from 'zod'

export const SupportTicketStatusEnum = z.enum([
  'OPEN',
  'AWAITING_REPLY',
  'CLOSED',
  'ASSIGNED',
  'PENDING_REVIEW',
])
export const SupportTicketPriorityEnum = z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
export const SupportTicketTypeEnum = z.enum([
  'CONSULT',
  'REPORT_COMPLAINTS',
  'FEEDBACK',
  'BUSINESS_COOPERATION',
])

export const AdminTicketListQuerySchema = z.object({
  status: SupportTicketStatusEnum.optional(),
  priority: SupportTicketPriorityEnum.optional(),
  type: SupportTicketTypeEnum.optional(),
  /** 'me' (default for CSAs) | 'unassigned' | an admin id (SUPER_ADMIN only) | 'all' (SUPER_ADMIN only). */
  assignedTo: z.string().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type AdminTicketListQuery = z.infer<typeof AdminTicketListQuerySchema>

export const AdminTicketParamsSchema = z.object({
  ticketId: z.coerce.bigint(),
})

export const AdminReplySchema = z.object({
  content: z.string().min(1).max(2000),
  imageUrl: z.string().url().optional(),
})

export const ResolveTicketSchema = z.object({
  resolution: z.enum(['RESOLVED', 'REJECTED']),
  /** Required reason posted into the ticket chat as a SUPPORT message. */
  note: z.string().min(1).max(2000),
})

export const AssignTicketSchema = z.object({
  adminId: z.string().min(1),
})

export const SetPrioritySchema = z.object({
  priority: SupportTicketPriorityEnum,
})

export const CreateNoteSchema = z.object({
  content: z.string().min(1).max(2000),
})

export const AdminTicketMessagesQuerySchema = z.object({
  cursor: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
})

export const AdminUploadUrlSchema = z.object({
  ticketId: z.coerce.bigint(),
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
})

export const NotificationListQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().default(false),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export const MarkNotificationsReadSchema = z.object({
  ids: z.array(z.string().min(1)).max(200).optional(),
})

export const AdminReportListQuerySchema = z.object({
  status: z.enum(['PENDING', 'REVIEWED', 'RESOLVED', 'DISMISSED']).optional(),
  context: z.enum(['CHAT', 'LIVE']).optional(),
  reason: z
    .enum(['SPAM', 'HARASSMENT', 'INAPPROPRIATE_CONTENT', 'FAKE_ACCOUNT', 'VIOLENCE', 'OTHER'])
    .optional(),
  reportedUserId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})
export type AdminReportListQuery = z.infer<typeof AdminReportListQuerySchema>

export const AdminReportParamsSchema = z.object({
  reportId: z.string().min(1),
})

export const ReviewReportSchema = z.object({
  status: z.enum(['REVIEWED', 'RESOLVED', 'DISMISSED']),
  resolutionNote: z.string().max(2000).optional(),
})
