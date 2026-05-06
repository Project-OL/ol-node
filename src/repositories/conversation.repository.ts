import type { Conversation, ConversationType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type ConversationWithMembers = Conversation & {
  members: Array<{
    id: string
    userId: string
    conversationId: string
    joinedAt: Date
    lastReadAt: Date | null
    isMuted: boolean
    mutedUntil: Date | null
    isDeleted: boolean
    deletedAt: Date | null
    user: {
      id: string
      username: string
      defaultPublicId: bigint
      avatarUrl: string | null
    }
  }>
}

export type ConversationWithMembersAndLastMessage = ConversationWithMembers & {
  messages: Array<{
    id: string
    type: string
    content: string | null
    createdAt: Date
    senderId: string
    isDeleted: boolean
  }>
}

export type ConversationPreview = {
  id: string
  type: ConversationType
  lastMessageAt: Date | null
  createdAt: Date
  updatedAt: Date
  members: Array<{
    id: string
    username: string
    avatarUrl: string | null
    defaultPublicId: string
  }>
  lastMessage: {
    id: string
    type: string
    content: string | null
    createdAt: Date
    senderId: string
    isDeleted: boolean
  } | null
}

export async function createConversation(data: {
  type: ConversationType
  memberIds: string[]
}): Promise<ConversationWithMembers> {
  const conv = await prisma.$transaction(async (tx) => {
    const c = await tx.conversation.create({
      data: { type: data.type },
    })
    await tx.conversationMember.createMany({
      data: data.memberIds.map((userId) => ({
        conversationId: c.id,
        userId,
      })),
    })
    return c
  })
  const withMembers = await prisma.conversation.findUnique({
    where: { id: conv.id },
    include: {
      members: {
        include: {
          user: { select: { id: true, username: true, defaultPublicId: true, avatarUrl: true } },
        },
      },
    },
  })
  if (!withMembers) throw new Error('Conversation not found after create')
  return withMembers as unknown as ConversationWithMembers
}

export async function findDirectConversation(
  userAId: string,
  userBId: string,
): Promise<Conversation | null> {
  const convIdsForA = await prismaRead.conversationMember.findMany({
    where: { userId: userAId, isDeleted: false },
    select: { conversationId: true },
  })
  const ids = convIdsForA.map((m) => m.conversationId)
  if (ids.length === 0) return null
  const conv = await prismaRead.conversation.findFirst({
    where: {
      id: { in: ids },
      type: 'DIRECT',
      members: {
        some: { userId: userBId, isDeleted: false },
      },
    },
  })
  return conv
}

export async function findConversationById(
  id: string,
  userId?: string,
): Promise<ConversationWithMembersAndLastMessage | null> {
  const conv = await prismaRead.conversation.findUnique({
    where: { id },
    include: {
      members: {
        include: {
          user: { select: { id: true, username: true, defaultPublicId: true, avatarUrl: true } },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          type: true,
          content: true,
          createdAt: true,
          senderId: true,
          isDeleted: true,
        },
      },
    },
  })
  if (!conv) return null
  if (userId !== undefined) {
    const member = conv.members.find((m) => m.userId === userId)
    if (!member || member.isDeleted) return null
  }
  return conv as unknown as ConversationWithMembersAndLastMessage
}

export async function listConversationsForUser(
  userId: string,
  cursor?: string,
  limit = 20,
): Promise<{ conversations: ConversationPreview[]; nextCursor: string | null }> {
  const memberConvIds = await prismaRead.conversationMember.findMany({
    where: { userId, isDeleted: false },
    select: { conversationId: true },
  })
  const convIds = memberConvIds.map((m) => m.conversationId)
  if (convIds.length === 0) {
    return { conversations: [], nextCursor: null }
  }
  const conversations = await prismaRead.conversation.findMany({
    where: {
      id: { in: convIds },
      ...(cursor ? { lastMessageAt: { lt: new Date(cursor) } } : {}),
    },
    orderBy: { lastMessageAt: 'desc' },
    take: limit + 1,
    include: {
      members: {
        where: { isDeleted: false },
        include: {
          user: { select: { id: true, username: true, avatarUrl: true, defaultPublicId: true } },
        },
      },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: {
          id: true,
          type: true,
          content: true,
          createdAt: true,
          senderId: true,
          isDeleted: true,
        },
      },
    },
  })
  const hasMore = conversations.length > limit
  const page = hasMore ? conversations.slice(0, limit) : conversations
  const lastItem = page[page.length - 1]
  const nextCursor =
    hasMore && lastItem?.lastMessageAt
      ? lastItem.lastMessageAt.toISOString()
      : null
  const previews: ConversationPreview[] = page.map((c) => ({
    id: c.id,
    type: c.type,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    members: c.members.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      avatarUrl: m.user.avatarUrl,
      defaultPublicId: m.user.defaultPublicId.toString(),
    })),
    lastMessage: c.messages[0]
      ? {
          id: c.messages[0].id,
          type: c.messages[0].type,
          content: c.messages[0].content
            ? c.messages[0].content.slice(0, 100)
            : c.messages[0].content,
          createdAt: c.messages[0].createdAt,
          senderId: c.messages[0].senderId,
          isDeleted: c.messages[0].isDeleted,
        }
      : null,
  }))
  return {
    conversations: previews,
    nextCursor: nextCursor ? String(nextCursor) : null,
  }
}

export async function updateLastMessageAt(
  conversationId: string,
  at: Date,
): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: at },
  })
}

export async function markConversationDeleted(
  conversationId: string,
  userId: string,
): Promise<void> {
  const now = new Date()
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data: { isDeleted: true, deletedAt: now },
  })
}

export async function updateMuteStatus(
  conversationId: string,
  userId: string,
  isMuted: boolean,
  mutedUntil: Date | null,
): Promise<void> {
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data: { isMuted, mutedUntil },
  })
}

export async function getConversationLastSeq(conversationId: string): Promise<bigint | null> {
  const row = await prismaRead.conversation.findUnique({
    where: { id: conversationId },
    select: { lastSeq: true },
  })
  return row?.lastSeq ?? null
}

/** Active membership (not soft-deleted). */
export async function isActiveConversationMember(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const m = await prismaRead.conversationMember.findFirst({
    where: { conversationId, userId, isDeleted: false },
    select: { id: true },
  })
  return m != null
}

export const conversationRepository = {
  createConversation,
  findDirectConversation,
  findConversationById,
  listConversationsForUser,
  updateLastMessageAt,
  markConversationDeleted,
  updateMuteStatus,
  getConversationLastSeq,
  isActiveConversationMember,
}
