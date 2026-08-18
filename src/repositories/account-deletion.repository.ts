import { prisma, prismaRead } from '../config/database'
import type { AccountDeletion, Prisma } from '@prisma/client'

const userSelect = {
  id: true,
  username: true,
  publicId: true,
  defaultPublicId: true,
  currentVipPublicId: true,
  firstName: true,
  lastName: true,
  status: true,
  avatarUrl: true,
  authIdentifiers: {
    select: {
      provider: true,
      identifier: true,
      isPrimary: true,
      isVerified: true,
    },
  },
} as const

export type AccountDeletionWithUser = Prisma.AccountDeletionGetPayload<{
  include: { user: { select: typeof userSelect } }
}>

export const accountDeletionRepository = {
  async findByUserId(userId: string): Promise<AccountDeletion | null> {
    return prismaRead.accountDeletion.findUnique({
      where: { userId },
    })
  },

  async findByIdWithUser(id: string): Promise<AccountDeletionWithUser | null> {
    return prismaRead.accountDeletion.findUnique({
      where: { id },
      include: { user: { select: userSelect } },
    })
  },

  async create(data: {
    userId: string
    scheduledAt: Date
    deactivationUntil: Date
    deletionAt: Date
    reason?: string
    ipAddress?: string
  }): Promise<AccountDeletion> {
    return prisma.accountDeletion.create({
      data: {
        userId: data.userId,
        scheduledAt: data.scheduledAt,
        deactivationUntil: data.deactivationUntil,
        deletionAt: data.deletionAt,
        reason: data.reason ?? undefined,
        ipAddress: data.ipAddress ?? undefined,
      },
    })
  },

  async upsertSchedule(data: {
    userId: string
    scheduledAt: Date
    deactivationUntil: Date
    deletionAt: Date
    reason?: string
    ipAddress?: string
  }): Promise<AccountDeletion> {
    return prisma.accountDeletion.upsert({
      where: { userId: data.userId },
      create: {
        userId: data.userId,
        scheduledAt: data.scheduledAt,
        deactivationUntil: data.deactivationUntil,
        deletionAt: data.deletionAt,
        reason: data.reason ?? undefined,
        ipAddress: data.ipAddress ?? undefined,
      },
      update: {
        scheduledAt: data.scheduledAt,
        deactivationUntil: data.deactivationUntil,
        deletionAt: data.deletionAt,
        reason: data.reason ?? undefined,
        ipAddress: data.ipAddress ?? undefined,
        isCancelled: false,
        cancelledAt: null,
        isDeleted: false,
        deletedAt: null,
        reminderSentAt: null,
      },
    })
  },

  async update(
    id: string,
    data: {
      isCancelled?: boolean
      cancelledAt?: Date | null
      isDeleted?: boolean
      deletedAt?: Date | null
      reminderSentAt?: Date | null
    },
  ): Promise<AccountDeletion> {
    return prisma.accountDeletion.update({
      where: { id },
      data,
    })
  },

  async claimReminder(id: string, sentAt: Date): Promise<boolean> {
    const result = await prisma.accountDeletion.updateMany({
      where: {
        id,
        isCancelled: false,
        isDeleted: false,
        reminderSentAt: null,
      },
      data: { reminderSentAt: sentAt },
    })
    return result.count === 1
  },

  async findForDeletion(now: Date): Promise<AccountDeletion[]> {
    return prismaRead.accountDeletion.findMany({
      where: {
        deletionAt: { lte: now },
        isDeleted: false,
        isCancelled: false,
      },
      orderBy: { deletionAt: 'asc' },
      include: { user: { select: { id: true } } },
    })
  },

  async findDueForReminder(now: Date, windowEnd: Date): Promise<AccountDeletion[]> {
    return prismaRead.accountDeletion.findMany({
      where: {
        isCancelled: false,
        isDeleted: false,
        reminderSentAt: null,
        deletionAt: { gt: now, lte: windowEnd },
      },
      orderBy: { deletionAt: 'asc' },
    })
  },

  async list(args: {
    where: Prisma.AccountDeletionWhereInput
    skip: number
    take: number
  }): Promise<{ items: AccountDeletionWithUser[]; total: number }> {
    const [items, total] = await Promise.all([
      prismaRead.accountDeletion.findMany({
        where: args.where,
        orderBy: { deletionAt: 'asc' },
        skip: args.skip,
        take: args.take,
        include: { user: { select: userSelect } },
      }),
      prismaRead.accountDeletion.count({ where: args.where }),
    ])
    return { items, total }
  },

  async resolveUserIdsByQuery(args: {
    q: string
    qType: 'auto' | 'userId' | 'publicId' | 'displayId'
  }): Promise<string[]> {
    const q = args.q.trim()
    if (!q) return []

    const asUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q)
    const asBigInt = /^\d+$/.test(q) ? BigInt(q) : null
    const type = args.qType

    if (type === 'userId' || (type === 'auto' && asUuid)) {
      if (!asUuid) return []
      const row = await prismaRead.user.findUnique({ where: { id: q }, select: { id: true } })
      return row ? [row.id] : []
    }

    if (type === 'publicId' || type === 'displayId' || (type === 'auto' && asBigInt != null)) {
      if (asBigInt == null) return []
      const rows = await prismaRead.user.findMany({
        where: {
          OR: [
            { publicId: asBigInt },
            { defaultPublicId: asBigInt },
            { currentVipPublicId: asBigInt },
          ],
        },
        select: { id: true },
        take: 20,
      })
      return rows.map((r) => r.id)
    }

    const identifierRows = await prismaRead.authIdentifier.findMany({
      where: { identifier: { equals: q, mode: 'insensitive' } },
      select: { userId: true },
      take: 20,
    })
    const usernameRows = await prismaRead.user.findMany({
      where: { username: { equals: q, mode: 'insensitive' } },
      select: { id: true },
      take: 20,
    })
    return [...new Set([...identifierRows.map((r) => r.userId), ...usernameRows.map((r) => r.id)])]
  },
}
