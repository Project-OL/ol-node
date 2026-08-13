import { z } from 'zod'

export const USER_RESTRICTION_TYPES = [
  'LIVE_CHAT_MUTE',
  'LIVE_AUDIO_MUTE',
  'MESSAGING_DISABLE',
  'LIVE_STREAM_START_BAN',
] as const

export const userRestrictionTypeSchema = z.enum(USER_RESTRICTION_TYPES)

export const adminApplyRestrictionBodySchema = z
  .object({
    type: userRestrictionTypeSchema,
    /** ISO-8601; must be in the future. */
    restrictedUntil: z.string().datetime(),
    reason: z.string().max(2000).optional(),
    /** Optional message_reports.id that triggered this action. */
    reportId: z.string().min(1).max(64).optional(),
    /**
     * MESSAGING_DISABLE only. Users this account cannot message.
     * Omit for a global send ban (cannot message anyone).
     */
    targetUserIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    /**
     * MESSAGING_DISABLE only. Union `targetUserIds` with the active ban and
     * keep the later of the two `restrictedUntil` dates.
     */
    extend: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.targetUserIds && data.type !== 'MESSAGING_DISABLE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'targetUserIds is only valid for MESSAGING_DISABLE',
        path: ['targetUserIds'],
      })
    }
    if (data.extend && data.type !== 'MESSAGING_DISABLE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'extend is only valid for MESSAGING_DISABLE',
        path: ['extend'],
      })
    }
  })

export const adminClearRestrictionTypeBodySchema = z.object({
  reason: z.string().max(2000).optional(),
})

export const adminListRestrictionsQuerySchema = z.object({
  includeCleared: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
})

export const adminStopLiveStreamBodySchema = z.object({
  reason: z.string().max(2000).optional(),
})

export type AdminApplyRestrictionBody = z.infer<typeof adminApplyRestrictionBodySchema>
