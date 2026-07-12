import { z } from 'zod'

export const CreateDMSchema = z.object({
  recipientPublicId: z.string().min(1),
})

const sendMessageMediaItemSchema = z
  .object({
    s3Key: z.string().min(1),
    mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']),
    fileName: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().positive().optional(),
    durationSec: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    order: z.number().int().min(0).optional(),
    bitrate: z.number().int().positive().max(2_000_000).optional(),
    sampleRate: z.number().int().positive().max(384_000).optional(),
    channels: z.number().int().min(1).max(16).optional(),
    codec: z.enum(['aac', 'mp3', 'opus', 'pcm_s16le', 'unknown']).optional(),
    /** Normalized peak envelope 0..1; server stores compact u8 base64 in `waveform_json`. */
    waveformPeaksNormalized: z.array(z.number()).max(200).optional(),
    /** Lowercase hex SHA-256 of object bytes when client computed it (must match S3 checksum if present). */
    checksumSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
  })
  .superRefine((item, ctx) => {
    if (!item.waveformPeaksNormalized?.length) return
    for (let i = 0; i < item.waveformPeaksNormalized.length; i++) {
      const p = item.waveformPeaksNormalized[i]!
      if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'waveformPeaksNormalized values must be finite numbers in [0,1]',
          path: ['waveformPeaksNormalized', i],
        })
      }
    }
  })

export const SendMessageSchema = z
  .object({
    /** UUID v4 from client — idempotent retries must reuse the same value per logical send. */
    clientMessageId: z.string().uuid(),
    content: z.string().max(4000).optional(),
    type: z.enum(['TEXT', 'TEXT_COINS', 'IMAGE', 'VIDEO', 'AUDIO', 'FILE']),
    // Client payloads often send null for "no reply"; normalize to undefined.
    replyToId: z.preprocess((v) => (v === null ? undefined : v), z.string().cuid().optional()),
    mediaItems: z.array(sendMessageMediaItemSchema).max(10).optional(),
  })
  .refine((d) => d.content?.trim() || (d.mediaItems && d.mediaItems.length > 0), {
    message: 'Message must have text content or at least one media item',
  })

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

export const CreateReportSchema = z
  .object({
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
    /** CHAT (default) = DM report; LIVE = report raised during a live broadcast. */
    context: z.enum(['CHAT', 'LIVE']).default('CHAT'),
    liveSessionId: z.string().min(1).max(200).optional(),
    hostUserId: z.string().uuid().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.context === 'LIVE' && !val.liveSessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['liveSessionId'],
        message: 'liveSessionId is required for LIVE reports',
      })
    }
  })

export const GetUploadUrlsSchema = z
  .object({
    /** Required when any file has mediaType AUDIO — used for scoped S3 keys and membership checks. */
    conversationId: z.string().cuid().optional(),
    files: z
      .array(
        z.object({
          mediaType: z.enum(['IMAGE', 'VIDEO', 'AUDIO', 'FILE']),
          fileName: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(100),
          sizeBytes: z.number().int().positive(),
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((data, ctx) => {
    if (data.files.some((f) => f.mediaType === 'AUDIO') && !data.conversationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'conversationId is required when uploading audio',
        path: ['conversationId'],
      })
    }
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
