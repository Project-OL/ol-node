import { z } from 'zod'

const cuid = z.string().cuid()
const uuid = z.string().uuid()

const userIdList = z.array(uuid).min(1).max(50)

export const clientFrameSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('JOIN'),
    conversationId: cuid,
  }),
  z.object({
    t: z.literal('LEAVE'),
    conversationId: cuid,
  }),
  z.object({
    t: z.literal('TYPING'),
    conversationId: cuid,
    isTyping: z.boolean(),
  }),
  z.object({
    t: z.literal('RECORDING'),
    conversationId: cuid,
    isRecording: z.boolean(),
  }),
  z.object({
    t: z.literal('PING'),
    ts: z.number(),
  }),
  z.object({
    t: z.literal('READ'),
    conversationId: cuid,
    lastReadMessageId: cuid,
  }),
  z.object({
    t: z.literal('JOIN_PRESENCE'),
    userIds: userIdList,
  }),
  z.object({
    t: z.literal('LEAVE_PRESENCE'),
    userIds: userIdList,
  }),
  z.object({
    t: z.literal('JOIN_GUARDIAN'),
    userIds: userIdList,
  }),
  z.object({
    t: z.literal('LEAVE_GUARDIAN'),
    userIds: userIdList,
  }),
  z.object({
    t: z.literal('RESUME'),
    conversations: z
      .array(
        z.object({
          conversationId: cuid,
          afterSeq: z.number().int().nonnegative().optional(),
        }),
      )
      .min(1)
      .max(30),
  }),
])
