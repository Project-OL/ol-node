import type { Conversation, ConversationType, Prisma } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import type { PlatformConversationType } from '../lib/platform-conversations.constants'
import { makeDirectPairKey } from '../utils/direct-pair-key'

const conversationMemberUserSelect = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  avatarUrl: true,
} as const

export type ConversationMemberUser = {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  /** firstName + lastName (space); empty when both missing. */
  name: string
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
}

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
    user: ConversationMemberUser
  }>
}

function mapConversationMemberUser(user: {
  id: string
  username: string
  firstName: string | null
  lastName: string | null
  publicId: bigint
  defaultPublicId: bigint
  currentVipPublicId: bigint | null
  avatarUrl: string | null
}): ConversationMemberUser {
  return {
    ...user,
    name: formatUserName(user),
  }
}

function withNamedMembers<T extends {
  members: Array<{
    user: {
      id: string
      username: string
      firstName: string | null
      lastName: string | null
      publicId: bigint
      defaultPublicId: bigint
      currentVipPublicId: bigint | null
      avatarUrl: string | null
    }
  }>
}>(conv: T): T {
  return {
    ...conv,
    members: conv.members.map((m) => ({
      ...m,
      user: mapConversationMemberUser(m.user),
    })),
  }
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
    name: string
    avatarUrl: string | null
    defaultPublicId: string
    displayPublicId: string
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
  /** When set, empty threads still appear in conversation list sort order. */
  lastMessageAt?: Date | null
  /** DIRECT only — unique sorted pair key. */
  directPairKey?: string | null
  tx?: Prisma.TransactionClient
}): Promise<ConversationWithMembers> {
  const run = async (tx: Prisma.TransactionClient) => {
    const c = await tx.conversation.create({
      data: {
        type: data.type,
        ...(data.lastMessageAt !== undefined ? { lastMessageAt: data.lastMessageAt } : {}),
        ...(data.directPairKey != null ? { directPairKey: data.directPairKey } : {}),
      },
    })
    const uniqueMemberIds = [...new Set(data.memberIds)]
    await tx.conversationMember.createMany({
      data: uniqueMemberIds.map((userId) => ({
        conversationId: c.id,
        userId,
      })),
    })
    return c
  }

  const conv = data.tx ? await run(data.tx) : await prisma.$transaction(run)
  const db = data.tx ?? prisma
  const withMembers = await db.conversation.findUnique({
    where: { id: conv.id },
    include: {
      members: {
        include: {
          user: { select: conversationMemberUserSelect },
        },
      },
    },
  })
  if (!withMembers) throw new Error('Conversation not found after create')
  return withNamedMembers(withMembers) as unknown as ConversationWithMembers
}

export async function findPlatformConversationForUser(
  userId: string,
  type: PlatformConversationType,
  opts?: { includeDeletedMembership?: boolean },
): Promise<Conversation | null> {
  return prismaRead.conversation.findFirst({
    where: {
      type,
      members: {
        some: opts?.includeDeletedMembership
          ? { userId }
          : { userId, isDeleted: false },
      },
    },
    orderBy: { createdAt: 'asc' },
  })
}

/** Re-list a soft-deleted platform membership so the thread shows in GET /conversations again. */
export async function reactivateMember(
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const result = await prisma.conversationMember.updateMany({
    where: { conversationId, userId, isDeleted: true },
    data: { isDeleted: false },
  })
  return result.count > 0
}

export async function createPlatformConversation(data: {
  type: PlatformConversationType
  userId: string
  platformSenderUserId: string
}): Promise<ConversationWithMembers> {
  const now = new Date()
  return createConversation({
    type: data.type,
    memberIds: [data.platformSenderUserId, data.userId],
    lastMessageAt: now,
  })
}

/**
 * Active DIRECT for unordered pair (both memberships not soft-deleted).
 * Uses `directPairKey` when present; falls back to exact 2-member match for legacy rows.
 */
export async function findDirectConversation(
  userAId: string,
  userBId: string,
): Promise<Conversation | null> {
  if (userAId === userBId) return null

  const pairKey = makeDirectPairKey(userAId, userBId)
  const byKey = await prismaRead.conversation.findUnique({
    where: { directPairKey: pairKey },
    include: { members: { select: { userId: true, isDeleted: true } } },
  })
  if (byKey) {
    const members = byKey.members
    if (members.length !== 2) return null
    const ids = new Set(members.map((m) => m.userId))
    if (!ids.has(userAId) || !ids.has(userBId)) return null
    if (members.some((m) => m.isDeleted)) return null
    const { members: _m, ...conv } = byKey
    return conv
  }

  return findDirectByExactMembers(userAId, userBId, { includeDeleted: false })
}

/**
 * DIRECT for unordered pair including soft-deleted memberships (for reactivate-on-create).
 */
export async function findDirectConversationIncludingDeleted(
  userAId: string,
  userBId: string,
): Promise<Conversation | null> {
  if (userAId === userBId) return null

  const pairKey = makeDirectPairKey(userAId, userBId)
  const byKey = await prismaRead.conversation.findUnique({
    where: { directPairKey: pairKey },
  })
  if (byKey) return byKey

  return findDirectByExactMembers(userAId, userBId, { includeDeleted: true })
}

async function findDirectByExactMembers(
  userAId: string,
  userBId: string,
  opts: { includeDeleted: boolean },
): Promise<Conversation | null> {
  const memberWhere = opts.includeDeleted
    ? { userId: userAId }
    : { userId: userAId, isDeleted: false }

  const convIdsForA = await prismaRead.conversationMember.findMany({
    where: memberWhere,
    select: { conversationId: true },
  })
  const ids = convIdsForA.map((m) => m.conversationId)
  if (ids.length === 0) return null

  const candidates = await prismaRead.conversation.findMany({
    where: {
      id: { in: ids },
      type: 'DIRECT',
      members: {
        some: opts.includeDeleted
          ? { userId: userBId }
          : { userId: userBId, isDeleted: false },
      },
    },
    include: {
      members: { select: { userId: true, isDeleted: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  for (const c of candidates) {
    if (c.members.length !== 2) continue
    const idSet = new Set(c.members.map((m) => m.userId))
    if (!idSet.has(userAId) || !idSet.has(userBId)) continue
    if (!opts.includeDeleted && c.members.some((m) => m.isDeleted)) continue
    const { members: _m, ...conv } = c
    return conv
  }
  return null
}

/** Advisory lock for DIRECT get-or-create (same transaction). */
export async function lockDirectPair(
  tx: Prisma.TransactionClient,
  pairKey: string,
): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dm-pair:${pairKey}`}, 0))::text AS locked`
}

/**
 * Batched findDirectConversation: existing DIRECT conversation id per contact in
 * `otherUserIds` (both memberships non-deleted, exactly 2 members) — one query.
 */
export async function findDirectConversationIdsWith(
  userId: string,
  otherUserIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (otherUserIds.length === 0) return map
  const others = otherUserIds.filter((id) => id !== userId)
  if (others.length === 0) return map

  const convs = await prismaRead.conversation.findMany({
    where: {
      type: 'DIRECT',
      members: { some: { userId, isDeleted: false } },
    },
    select: {
      id: true,
      directPairKey: true,
      members: {
        select: { userId: true, isDeleted: true },
      },
    },
  })
  const otherSet = new Set(others)
  for (const conv of convs) {
    if (conv.members.length !== 2) continue
    if (conv.members.some((m) => m.isDeleted)) continue
    const other = conv.members.find((m) => m.userId !== userId)
    if (!other || !otherSet.has(other.userId)) continue
    if (!map.has(other.userId)) {
      map.set(other.userId, conv.id)
    }
  }
  return map
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
          user: { select: conversationMemberUserSelect },
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
  return withNamedMembers(conv) as unknown as ConversationWithMembersAndLastMessage
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
  // Exclude never-messaged shells (`lastMessageAt` null). Postgres DESC sorts NULLs
  // first by default, which buried real DMs under empty create-without-send threads.
  // Platform SYSTEM/NOTIFICATION/TRANSACTIONAL rows set lastMessageAt on create, so
  // they still appear.
  const conversations = await prismaRead.conversation.findMany({
    where: {
      id: { in: convIds },
      lastMessageAt: cursor
        ? { not: null, lt: new Date(cursor) }
        : { not: null },
    },
    orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
    take: limit + 1,
    include: {
      members: {
        where: { isDeleted: false },
        include: {
          user: { select: conversationMemberUserSelect },
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
    hasMore && lastItem?.lastMessageAt ? lastItem.lastMessageAt.toISOString() : null
  const previews: ConversationPreview[] = page.map((c) => ({
    id: c.id,
    type: c.type,
    lastMessageAt: c.lastMessageAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    members: c.members.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      name: formatUserName(m.user),
      avatarUrl: m.user.avatarUrl,
      defaultPublicId: m.user.defaultPublicId.toString(),
      displayPublicId: resolveDisplayPublicId(m.user),
    })),
    lastMessage: (() => {
      const clearedAt = c.members.find((m) => m.userId === userId)?.deletedAt ?? null
      const msg = c.messages[0]
      if (!msg || (clearedAt && msg.createdAt <= clearedAt)) return null
      return {
        id: msg.id,
        type: msg.type,
        content: msg.content ? msg.content.slice(0, 100) : msg.content,
        createdAt: msg.createdAt,
        senderId: msg.senderId,
        isDeleted: msg.isDeleted,
      }
    })(),
  }))
  return {
    conversations: previews,
    nextCursor: nextCursor ? String(nextCursor) : null,
  }
}

export async function updateLastMessageAt(conversationId: string, at: Date): Promise<void> {
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

/**
 * Re-activates every soft-cleared (`isDeleted=true`) membership on a conversation — called when a
 * new message flows through it, so a cleared conversation "reappears" for whoever cleared it
 * (sender or recipient), per the clear-chat-history contract. `deletedAt` is left untouched so
 * history predating the clear stays hidden; only the list/send gate (`isDeleted`) is lifted.
 */
export async function reactivateConversationMembers(conversationId: string): Promise<string[]> {
  const cleared = await prisma.conversationMember.findMany({
    where: { conversationId, isDeleted: true },
    select: { userId: true },
  })
  if (cleared.length === 0) return []
  await prisma.conversationMember.updateMany({
    where: { conversationId, isDeleted: true },
    data: { isDeleted: false },
  })
  return cleared.map((m) => m.userId)
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

/** Bulk read-cursor update: every active conversation with at least one message. */
export async function markAllConversationsRead(
  userId: string,
): Promise<Array<{ conversationId: string; lastReadMessageId: string }>> {
  const rows = await prisma.$queryRaw<
    { conversation_id: string; last_read_message_id: string | null }[]
  >`
    UPDATE conversation_members cm
    SET last_read_at = now(),
        last_read_message_id = (
          SELECT m.id FROM messages m
          WHERE m.conversation_id = cm.conversation_id
          ORDER BY m.seq DESC
          LIMIT 1
        )
    WHERE cm.user_id = ${userId}::uuid
      AND cm.is_deleted = false
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = cm.conversation_id)
    RETURNING cm.conversation_id, cm.last_read_message_id
  `
  return rows
    .filter((r) => r.last_read_message_id !== null)
    .map((r) => ({
      conversationId: r.conversation_id,
      lastReadMessageId: r.last_read_message_id!,
    }))
}

/** Soft-deletes every active DIRECT-conversation membership row for a user — removes those conversations from their list (platform/system/notification/transactional threads are untouched). */
export async function markAllConversationsDeleted(userId: string): Promise<string[]> {
  const now = new Date()
  const memberships = await prisma.conversationMember.findMany({
    where: { userId, isDeleted: false, conversation: { type: 'DIRECT' } },
    select: { conversationId: true },
  })
  const conversationIds = memberships.map((m) => m.conversationId)
  if (conversationIds.length === 0) return []
  await prisma.conversationMember.updateMany({
    where: { userId, conversationId: { in: conversationIds } },
    data: { isDeleted: true, deletedAt: now },
  })
  return conversationIds
}

/** Soft-deletes only the caller-supplied conversation ids the user is actually an active DIRECT-conversation member of (non-DIRECT ids are silently dropped, same as ids the caller isn't a member of). */
export async function markConversationsDeletedBulk(
  userId: string,
  conversationIds: string[],
): Promise<string[]> {
  const now = new Date()
  const memberships = await prisma.conversationMember.findMany({
    where: {
      userId,
      conversationId: { in: conversationIds },
      isDeleted: false,
      conversation: { type: 'DIRECT' },
    },
    select: { conversationId: true },
  })
  const validIds = memberships.map((m) => m.conversationId)
  if (validIds.length === 0) return []
  await prisma.conversationMember.updateMany({
    where: { userId, conversationId: { in: validIds } },
    data: { isDeleted: true, deletedAt: now },
  })
  return validIds
}

/**
 * Clears message history for the caller only (`deletedAt` cutoff, same field `listMessages`
 * already filters on) WITHOUT setting `isDeleted` — the conversation stays in their list,
 * unlike `markConversationDeleted` which hides it too.
 */
export async function clearMessagesKeepConversation(
  conversationId: string,
  userId: string,
): Promise<void> {
  await prisma.conversationMember.updateMany({
    where: { conversationId, userId },
    data: { deletedAt: new Date() },
  })
}

export const conversationRepository = {
  createConversation,
  createPlatformConversation,
  findPlatformConversationForUser,
  reactivateMember,
  findDirectConversation,
  findDirectConversationIncludingDeleted,
  lockDirectPair,
  findDirectConversationIdsWith,
  findConversationById,
  listConversationsForUser,
  updateLastMessageAt,
  markConversationDeleted,
  updateMuteStatus,
  getConversationLastSeq,
  isActiveConversationMember,
  markAllConversationsRead,
  markAllConversationsDeleted,
  markConversationsDeletedBulk,
  clearMessagesKeepConversation,
  reactivateConversationMembers,
}
