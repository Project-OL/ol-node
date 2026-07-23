import {
  Prisma,
  MediaProcessingStatus,
  MediaTranscriptionStatus,
  type Message,
  type MessageReaction,
  type MessageType,
  type MediaType,
} from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import type { ServerFrame } from '../realtime/types'
import { storageService } from '../services/storage.service'
import { buildUserDisplayName, resolveDisplayPublicId } from '../utils/user-display'

export type MediaItemInput = {
  s3Key: string
  s3Bucket: string
  mediaType: MediaType
  fileName?: string
  mimeType?: string
  sizeBytes?: number
  durationSec?: number
  width?: number
  height?: number
  order: number
  waveformJson?: Prisma.InputJsonValue
  codec?: string
  bitrate?: number
  sampleRate?: number
  channels?: number
  processingStatus?: MediaProcessingStatus
  transcriptionStatus?: MediaTranscriptionStatus
  checksumSha256?: string
}

const senderSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  avatarUrl: true,
} as const

export type MessageWithDetails = Message & {
  metadata: unknown | null
  sender: {
    id: string
    username: string
    firstName: string | null
    lastName: string | null
    publicId: bigint
    defaultPublicId: bigint
    currentVipPublicId: bigint | null
    name: string
    displayPublicId: string
    avatarUrl: string | null
  }
  mediaItems: Array<{
    id: string
    messageId: string
    mediaType: MediaType
    s3Key: string
    s3Bucket: string
    mediaUrl: string
    fileName: string | null
    mimeType: string | null
    sizeBytes: number | null
    durationSec: number | null
    width: number | null
    height: number | null
    order: number
    waveformJson: unknown
    codec: string | null
    bitrate: number | null
    sampleRate: number | null
    channels: number | null
    processingStatus: MediaProcessingStatus
    transcriptionStatus: MediaTranscriptionStatus
    checksumSha256: string | null
    streamingUrl: string
    createdAt?: Date | null
  }>
  replyTo: {
    id: string
    content: string | null
    senderId: string
    type: MessageType
    sender: { username: string }
  } | null
  reactions: Array<{
    emoji: string
    count: number
    reactedByMe: boolean
  }>
}

const fullMessageInclude = {
  sender: { select: senderSelect },
  mediaItems: { orderBy: { order: 'asc' as const } },
  replyTo: {
    select: {
      id: true,
      content: true,
      senderId: true,
      type: true,
      sender: { select: { username: true } },
    },
  },
  reactions: { select: { emoji: true, userId: true } },
} as const

export type SendMessageWithOutboxInput = {
  conversationId: string
  senderId: string
  clientMessageId: string
  type: MessageType
  content?: string
  metadata?: Prisma.InputJsonValue
  replyToId?: string
  mediaItems?: MediaItemInput[]
  isAutoReply?: boolean
}

export type SendMessageWithOutboxResult =
  | { status: 'created'; message: MessageWithDetails; outboxId: bigint }
  | { status: 'duplicate'; message: MessageWithDetails }

function messageToJsonSafeRecord(msg: MessageWithDetails): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(msg, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
  ) as Record<string, unknown>
}

/**
 * Idempotent send: locks conversation row, returns existing message when `clientMessageId` repeats.
 * Inserts `message_outbox` for WS fan-out (published by worker after commit).
 */
export async function sendMessageWithOutbox(
  data: SendMessageWithOutboxInput,
): Promise<SendMessageWithOutboxResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT id FROM conversations WHERE id = ${data.conversationId} FOR UPDATE`,
      )

      const duplicate = await tx.message.findUnique({
        where: {
          conversationId_clientMessageId: {
            conversationId: data.conversationId,
            clientMessageId: data.clientMessageId,
          },
        },
      })

      if (duplicate) {
        const full = await tx.message.findUniqueOrThrow({
          where: { id: duplicate.id },
          include: fullMessageInclude,
        })
        return {
          status: 'duplicate',
          message: mapToMessageWithDetails(full, data.senderId),
        }
      }

      const now = new Date()
      const conv = await tx.conversation.update({
        where: { id: data.conversationId },
        data: {
          lastSeq: { increment: 1n },
          lastMessageAt: now,
        },
        select: { lastSeq: true },
      })
      const seq = conv.lastSeq

      const m = await tx.message.create({
        data: {
          conversationId: data.conversationId,
          senderId: data.senderId,
          type: data.type,
          content: data.content,
          metadata: data.metadata,
          replyToId: data.replyToId,
          seq,
          clientMessageId: data.clientMessageId,
          isAutoReply: data.isAutoReply ?? false,
        },
      })

      if (data.mediaItems && data.mediaItems.length > 0) {
        await tx.messageMedia.createMany({
          data: data.mediaItems.map((item) => {
            const row: Prisma.MessageMediaCreateManyInput = {
              messageId: m.id,
              mediaType: item.mediaType,
              s3Key: item.s3Key,
              s3Bucket: item.s3Bucket,
              fileName: item.fileName,
              mimeType: item.mimeType,
              sizeBytes: item.sizeBytes,
              durationSec: item.durationSec,
              width: item.width,
              height: item.height,
              order: item.order,
              codec: item.codec,
              bitrate: item.bitrate,
              sampleRate: item.sampleRate,
              channels: item.channels,
              processingStatus: item.processingStatus ?? MediaProcessingStatus.NONE,
              transcriptionStatus: item.transcriptionStatus ?? MediaTranscriptionStatus.NONE,
              checksumSha256: item.checksumSha256,
            }
            if (item.waveformJson !== undefined) {
              row.waveformJson = item.waveformJson as Prisma.InputJsonValue
            }
            return row
          }),
        })
      }

      const full = await tx.message.findUniqueOrThrow({
        where: { id: m.id },
        include: fullMessageInclude,
      })
      const message = mapToMessageWithDetails(full, data.senderId)

      const frame: ServerFrame = {
        t: 'NEW_MESSAGE',
        conversationId: data.conversationId,
        message: messageToJsonSafeRecord(message),
        seq: Number(message.seq),
      }

      const outbox = await tx.messageOutbox.create({
        data: {
          conversationId: data.conversationId,
          payload: frame as Prisma.InputJsonValue,
        },
      })

      return {
        status: 'created',
        message,
        outboxId: outbox.id,
      }
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5000,
      timeout: 15000,
    },
  )
}

function mapToMessageWithDetails(
  msg: {
    id: string
    conversationId: string
    senderId: string
    type: MessageType
    seq: bigint
    content: string | null
    metadata?: unknown | null
    replyToId: string | null
    isDeleted: boolean
    deletedAt: Date | null
    isAutoReply: boolean
    createdAt: Date
    updatedAt: Date
    sender: {
      id: string
      username: string
      firstName: string | null
      lastName: string | null
      publicId: bigint
      defaultPublicId: bigint
      currentVipPublicId: bigint | null
      avatarUrl: string | null
    }
    mediaItems: Array<{
      id: string
      messageId: string
      mediaType: MediaType
      s3Key: string
      s3Bucket: string
      fileName: string | null
      mimeType: string | null
      sizeBytes: number | null
      durationSec: number | null
      width: number | null
      height: number | null
      order: number
      waveformJson: unknown
      codec: string | null
      bitrate: number | null
      sampleRate: number | null
      channels: number | null
      processingStatus: MediaProcessingStatus
      transcriptionStatus: MediaTranscriptionStatus
      checksumSha256: string | null
      createdAt: Date | null
    }>
    replyTo: {
      id: string
      content: string | null
      senderId: string
      type: MessageType
      sender: { username: string }
    } | null
    reactions: Array<{ emoji: string; userId: string }>
  },
  currentUserId: string | undefined,
): MessageWithDetails {
  const byEmoji = new Map<string, { count: number; reactedByMe: boolean }>()
  for (const r of msg.reactions) {
    const existing = byEmoji.get(r.emoji) ?? { count: 0, reactedByMe: false }
    existing.count += 1
    if (currentUserId && r.userId === currentUserId) existing.reactedByMe = true
    byEmoji.set(r.emoji, existing)
  }
  const reactions = Array.from(byEmoji.entries()).map(([emoji, v]) => ({
    emoji,
    count: v.count,
    reactedByMe: v.reactedByMe,
  }))
  const mediaItemsWithUrl = msg.mediaItems.map((item) => {
    const url = storageService.getCdnOrS3PublicUrl(item.s3Key)
    return {
      ...item,
      mediaUrl: url,
      streamingUrl: url,
    }
  })
  return {
    ...msg,
    sender: {
      id: msg.sender.id,
      username: msg.sender.username,
      firstName: msg.sender.firstName,
      lastName: msg.sender.lastName,
      publicId: msg.sender.publicId,
      defaultPublicId: msg.sender.defaultPublicId,
      currentVipPublicId: msg.sender.currentVipPublicId,
      name: buildUserDisplayName(msg.sender),
      displayPublicId: resolveDisplayPublicId(msg.sender),
      avatarUrl: msg.sender.avatarUrl,
    },
    mediaItems: mediaItemsWithUrl,
    replyTo: msg.replyTo,
    reactions,
  } as MessageWithDetails
}

export async function listMessages(
  conversationId: string,
  userId: string,
  cursor?: string,
  limit = 30,
): Promise<{ messages: MessageWithDetails[]; nextCursor: string | null }> {
  const member = await prismaRead.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { deletedAt: true },
  })
  if (!member) return { messages: [], nextCursor: null }

  const where: {
    conversationId: string
    createdAt?: { gt?: Date; lt?: Date }
  } = { conversationId }
  if (member.deletedAt || cursor) {
    where.createdAt = {}
    if (member.deletedAt) where.createdAt.gt = member.deletedAt
    if (cursor) where.createdAt.lt = new Date(cursor)
  }
  const messages = await prismaRead.message.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: {
      sender: { select: senderSelect },
      mediaItems: { orderBy: { order: 'asc' } },
      replyTo: {
        select: {
          id: true,
          content: true,
          senderId: true,
          type: true,
          sender: { select: { username: true } },
        },
      },
    },
  })

  const hasMore = messages.length > limit
  const page = hasMore ? messages.slice(0, limit) : messages
  const nextCursor =
    hasMore && page[page.length - 1] ? page[page.length - 1].createdAt.toISOString() : null

  // Aggregate reactions in two DB-side queries instead of transferring every row to app memory.
  // 1) groupBy gives (messageId, emoji) → count.
  // 2) A second narrow query gets only the requesting user's reactions for the reactedByMe flag.
  const messageIds = page.map((m) => m.id)
  const [reactionCounts, myReactions] =
    messageIds.length > 0
      ? await Promise.all([
          prismaRead.messageReaction.groupBy({
            by: ['messageId', 'emoji'],
            where: { messageId: { in: messageIds } },
            _count: { _all: true },
          }),
          prismaRead.messageReaction.findMany({
            where: { messageId: { in: messageIds }, userId },
            select: { messageId: true, emoji: true },
          }),
        ])
      : [[], []]

  const myReactionSet = new Set(myReactions.map((r) => `${r.messageId}:${r.emoji}`))
  const reactionsByMessage = new Map<
    string,
    Array<{ emoji: string; count: number; reactedByMe: boolean }>
  >()
  for (const rc of reactionCounts) {
    if (!reactionsByMessage.has(rc.messageId)) reactionsByMessage.set(rc.messageId, [])
    reactionsByMessage.get(rc.messageId)!.push({
      emoji: rc.emoji,
      count: rc._count._all,
      reactedByMe: myReactionSet.has(`${rc.messageId}:${rc.emoji}`),
    })
  }

  const withDetails = page.map((m) => {
    const mapped = mapToMessageWithDetails({ ...m, reactions: [] }, userId)
    // Overwrite reactions with the aggregated result
    mapped.reactions = reactionsByMessage.get(m.id) ?? []
    if (m.isDeleted) {
      mapped.content = null
      mapped.mediaItems = []
    }
    return mapped
  })
  return { messages: withDetails, nextCursor }
}

export async function findMessageById(id: string): Promise<Message | null> {
  return prismaRead.message.findUnique({
    where: { id },
  })
}

export type MessageSearchRow = {
  id: string
  conversationId: string
  senderId: string
  type: MessageType
  content: string | null
  createdAt: Date
}

/** Text search over message content, scoped to the caller's active memberships and their per-conversation clear cutoff (same rule `listMessages` applies). */
export async function searchMessages(
  userId: string,
  query: string,
  opts: { limit: number; cursor?: string },
): Promise<MessageSearchRow[]> {
  const cursorCondition = opts.cursor
    ? Prisma.sql`AND m.created_at < ${new Date(opts.cursor)}`
    : Prisma.empty
  return prismaRead.$queryRaw<MessageSearchRow[]>`
    SELECT m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId",
           m.type, m.content, m.created_at AS "createdAt"
    FROM messages m
    INNER JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id AND cm.user_id = ${userId}::uuid
    WHERE cm.is_deleted = false
      AND m.is_deleted = false
      AND m.content ILIKE '%' || ${query} || '%'
      AND (cm.deleted_at IS NULL OR m.created_at > cm.deleted_at)
      ${cursorCondition}
    ORDER BY m.created_at DESC
    LIMIT ${opts.limit + 1}
  `
}

/** Sender may edit or delete their own message only within this window of sending it. */
export const MESSAGE_ACTION_WINDOW_MS = 60 * 60 * 1000

export async function softDeleteMessage(id: string, requestingUserId: string): Promise<Message> {
  const msg = await prisma.message.findUnique({
    where: { id },
  })
  if (!msg) throw new AppError(404, 'Message not found', 'NOT_FOUND')
  if (msg.senderId !== requestingUserId) {
    throw new AppError(403, 'Forbidden', 'FORBIDDEN')
  }
  if (Date.now() - msg.createdAt.getTime() > MESSAGE_ACTION_WINDOW_MS) {
    throw new AppError(403, 'Delete window has expired', 'MESSAGE_DELETE_WINDOW_EXPIRED')
  }
  const now = new Date()
  return prisma.message.update({
    where: { id },
    data: { isDeleted: true, deletedAt: now },
  })
}

export async function editMessage(
  id: string,
  requestingUserId: string,
  content: string,
): Promise<Message> {
  const msg = await prisma.message.findUnique({
    where: { id },
  })
  if (!msg) throw new AppError(404, 'Message not found', 'NOT_FOUND')
  if (msg.senderId !== requestingUserId) {
    throw new AppError(403, 'Forbidden', 'FORBIDDEN')
  }
  if (msg.isDeleted) {
    throw new AppError(409, 'Message has been deleted', 'MESSAGE_ALREADY_DELETED')
  }
  if (Date.now() - msg.createdAt.getTime() > MESSAGE_ACTION_WINDOW_MS) {
    throw new AppError(403, 'Edit window has expired', 'MESSAGE_EDIT_WINDOW_EXPIRED')
  }
  return prisma.message.update({
    where: { id },
    data: { content, editedAt: new Date() },
  })
}

export async function upsertReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<MessageReaction> {
  return prisma.messageReaction.upsert({
    where: {
      messageId_userId_emoji: { messageId, userId, emoji },
    },
    create: { messageId, userId, emoji },
    update: {},
  })
}

export async function removeReaction(
  messageId: string,
  userId: string,
  emoji: string,
): Promise<void> {
  await prisma.messageReaction.deleteMany({
    where: { messageId, userId, emoji },
  })
}

export async function markAsRead(conversationId: string, userId: string): Promise<void> {
  const now = new Date()
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data: { lastReadAt: now },
  })
}

/** Validates membership + message; ignores regressions (same or older seq than stored cursor). */
export async function updateReadCursor(
  conversationId: string,
  userId: string,
  messageId: string,
): Promise<boolean> {
  const member = await prismaRead.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadMessageId: true },
  })
  if (!member) {
    throw new AppError(403, 'Not a member', 'FORBIDDEN')
  }
  const msg = await prismaRead.message.findFirst({
    where: { id: messageId, conversationId, isDeleted: false },
    select: { id: true, createdAt: true, seq: true, senderId: true, isAutoReply: true },
  })
  if (!msg) {
    throw new AppError(400, 'Invalid message', 'INVALID_MESSAGE')
  }
  if (msg.isAutoReply && msg.senderId === userId) {
    return false
  }
  if (member.lastReadMessageId) {
    const prev = await prismaRead.message.findUnique({
      where: { id: member.lastReadMessageId },
      select: { seq: true },
    })
    if (prev && msg.seq <= prev.seq) {
      return false
    }
  }
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: {
      lastReadAt: msg.createdAt,
      lastReadMessageId: msg.id,
    },
  })
  return true
}

export async function getUnreadCount(conversationId: string, userId: string): Promise<number> {
  const member = await prismaRead.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadAt: true, lastReadMessageId: true },
  })
  if (!member) return 0
  let since = member.lastReadAt ?? new Date(0)
  if (member.lastReadMessageId) {
    const cursorMsg = await prismaRead.message.findUnique({
      where: { id: member.lastReadMessageId },
      select: { createdAt: true },
    })
    if (cursorMsg && cursorMsg.createdAt > since) {
      since = cursorMsg.createdAt
    }
  }
  return prismaRead.message.count({
    where: {
      conversationId,
      senderId: { not: userId },
      isDeleted: false,
      createdAt: { gt: since },
    },
  })
}

/** True if the conversation has at least one TEXT_COINS message (coin inquiry thread). */
export async function conversationHasTextCoins(conversationId: string): Promise<boolean> {
  const row = await prismaRead.message.findFirst({
    where: { conversationId, type: 'TEXT_COINS', isDeleted: false },
    select: { id: true },
  })
  return row != null
}

export const messageRepository = {
  sendMessageWithOutbox,
  listMessages,
  findMessageById,
  conversationHasTextCoins,
  softDeleteMessage,
  editMessage,
  searchMessages,
  upsertReaction,
  removeReaction,
  markAsRead,
  updateReadCursor,
  getUnreadCount,
}
