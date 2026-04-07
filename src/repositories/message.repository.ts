import type { Message, MessageReaction, MessageType, MediaType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { AppError } from '../middlewares/errorHandler'

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
}

const senderSelect = {
  id: true,
  username: true,
  defaultPublicId: true,
  avatarUrl: true,
} as const

export type MessageWithDetails = Message & {
  sender: {
    id: string
    username: string
    defaultPublicId: bigint
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

export async function createMessage(data: {
  conversationId: string
  senderId: string
  type: MessageType
  content?: string
  replyToId?: string
  mediaItems?: MediaItemInput[]
}): Promise<MessageWithDetails> {
  const full = await prisma.$transaction(async (tx) => {
    const m = await tx.message.create({
      data: {
        conversationId: data.conversationId,
        senderId: data.senderId,
        type: data.type,
        content: data.content,
        replyToId: data.replyToId,
      },
    })
    if (data.mediaItems && data.mediaItems.length > 0) {
      await tx.messageMedia.createMany({
        data: data.mediaItems.map((item) => ({
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
        })),
      })
    }
    return tx.message.findUniqueOrThrow({
      where: { id: m.id },
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
        reactions: { select: { emoji: true, userId: true } },
      },
    })
  })
  return mapToMessageWithDetails(full, undefined)
}

function mapToMessageWithDetails(
  msg: {
    id: string
    conversationId: string
    senderId: string
    type: MessageType
    content: string | null
    replyToId: string | null
    isDeleted: boolean
    deletedAt: Date | null
    createdAt: Date
    updatedAt: Date
    sender: { id: string; username: string; defaultPublicId: bigint; avatarUrl: string | null }
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
  return {
    ...msg,
    sender: msg.sender,
    mediaItems: msg.mediaItems,
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
  const nextCursor = hasMore && page[page.length - 1]
    ? page[page.length - 1].createdAt.toISOString()
    : null

  // Aggregate reactions in two DB-side queries instead of transferring every row to app memory.
  // 1) groupBy gives (messageId, emoji) → count.
  // 2) A second narrow query gets only the requesting user's reactions for the reactedByMe flag.
  const messageIds = page.map((m) => m.id)
  const [reactionCounts, myReactions] = messageIds.length > 0
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
  const reactionsByMessage = new Map<string, Array<{ emoji: string; count: number; reactedByMe: boolean }>>()
  for (const rc of reactionCounts) {
    if (!reactionsByMessage.has(rc.messageId)) reactionsByMessage.set(rc.messageId, [])
    reactionsByMessage.get(rc.messageId)!.push({
      emoji: rc.emoji,
      count: rc._count._all,
      reactedByMe: myReactionSet.has(`${rc.messageId}:${rc.emoji}`),
    })
  }

  const withDetails = page.map((m) => {
    const mapped = mapToMessageWithDetails(
      { ...m, reactions: [] },
      userId,
    )
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

export async function softDeleteMessage(
  id: string,
  requestingUserId: string,
): Promise<Message> {
  const msg = await prisma.message.findUnique({
    where: { id },
  })
  if (!msg) throw new AppError(404, 'Message not found', 'NOT_FOUND')
  if (msg.senderId !== requestingUserId) {
    throw new AppError(403, 'Forbidden', 'FORBIDDEN')
  }
  const now = new Date()
  return prisma.message.update({
    where: { id },
    data: { isDeleted: true, deletedAt: now },
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

export async function markAsRead(
  conversationId: string,
  userId: string,
): Promise<void> {
  const now = new Date()
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data: { lastReadAt: now },
  })
}

export async function getUnreadCount(
  conversationId: string,
  userId: string,
): Promise<number> {
  const member = await prismaRead.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
    select: { lastReadAt: true },
  })
  if (!member) return 0
  const since = member.lastReadAt ?? new Date(0)
  return prismaRead.message.count({
    where: {
      conversationId,
      senderId: { not: userId },
      isDeleted: false,
      createdAt: { gt: since },
    },
  })
}

export const messageRepository = {
  createMessage,
  listMessages,
  findMessageById,
  softDeleteMessage,
  upsertReaction,
  removeReaction,
  markAsRead,
  getUnreadCount,
}
