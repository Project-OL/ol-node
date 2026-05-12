import { z } from 'zod'

export const CreateDMSchema = z.object({
  recipientPublicId: z.string().min(1),
})

export const SendMessageSchema = z
  .object({
    /** UUID v4 from client — idempotent retries must reuse the same value per logical send. */
    clientMessageId: z.string().uuid(),
    content: z.string().max(4000).optional(),
    type: z.enum(['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE']),
    // Client payloads often send null for "no reply"; normalize to undefined.
    replyToId: z.preprocess((v) => (v === null ? undefined : v), z.string().cuid().optional()),
    mediaItems: z
      .array(
        z.object({
          s3Key: z.string().min(1),
          mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']),
          fileName: z.string().optional(),
          mimeType: z.string().optional(),
          sizeBytes: z.number().int().positive().optional(),
          durationSec: z.number().int().positive().optional(),
          width: z.number().int().positive().optional(),
          height: z.number().int().positive().optional(),
          order: z.number().int().min(0),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine(
    (d) => d.content?.trim() || (d.mediaItems && d.mediaItems.length > 0),
    { message: 'Message must have text content or at least one media item' },
  )

export const ListMessagesSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
})

export const ListConversationsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

export const AddReactionSchema = z.object({
  emoji: z.string().min(1).max(10),
})

export const MuteConversationSchema = z.object({
  mutedUntil: z.string().datetime().nullable().optional(),
})

export const BlockUserSchema = z.object({
  publicId: z.string().min(1),
})
export const BulkUnblockSchema = z.object({
  publicIds: z.array(z.string().min(1)).min(1).max(50),
})
export const GetBlockListSchema = z.object({
  search: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/** Query: whether the current user has blocked this public ID. */
export const CheckBlockQuerySchema = z.object({
  publicId: z.string().min(1, 'publicId is required'),
})

export const CreateReportSchema = z.object({
  reportedUserId: z.string().uuid(),
  conversationId: z.string().cuid().optional(),
  messageId: z.string().cuid().optional(),
  reason: z.enum([
    'SPAM',
    'HARASSMENT',
    'INAPPROPRIATE_CONTENT',
    'FAKE_ACCOUNT',
    'VIOLENCE',
    'OTHER',
  ]),
  additionalInfo: z.string().max(1000).optional(),
  evidenceS3Keys: z.array(z.string().min(1)).max(5).optional(),
})

export const GetUploadUrlsSchema = z.object({
  files: z.array(
    z.object({
      mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(100),
      sizeBytes: z.number().int().positive(),
    }),
  ).min(1).max(10),
})

export const SetBroadcastReminderSchema = z.object({
  creatorPublicId: z.string().min(1),
  remindAt: z.string().datetime(),
})

export type CreateDMInput = z.infer<typeof CreateDMSchema>
export type SendMessageInput = z.infer<typeof SendMessageSchema>
export type ListMessagesInput = z.infer<typeof ListMessagesSchema>
export type ListConversationsInput = z.infer<typeof ListConversationsSchema>
export type AddReactionInput = z.infer<typeof AddReactionSchema>
export type MuteConversationInput = z.infer<typeof MuteConversationSchema>
export type BlockUserInput = z.infer<typeof BlockUserSchema>
export type BulkUnblockInput = z.infer<typeof BulkUnblockSchema>
export type GetBlockListInput = z.infer<typeof GetBlockListSchema>
export type CheckBlockQueryInput = z.infer<typeof CheckBlockQuerySchema>
export type CreateReportInput = z.infer<typeof CreateReportSchema>
export type GetUploadUrlsInput = z.infer<typeof GetUploadUrlsSchema>
export type SetBroadcastReminderInput = z.infer<typeof SetBroadcastReminderSchema>
