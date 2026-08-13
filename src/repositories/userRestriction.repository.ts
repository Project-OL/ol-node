import type { UserRestriction, UserRestrictionType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type CreateUserRestrictionData = {
  userId: string
  type: UserRestrictionType
  restrictedUntil: Date
  reason?: string | null
  reportId?: string | null
  createdByAdminId: string
  /** Recipients for MESSAGING_DISABLE. Empty/omitted = all users. */
  targetUserIds?: string[]
}

const targetsInclude = {
  targets: { select: { targetUserId: true } },
} as const

export type UserRestrictionWithTargets = UserRestriction & {
  targets: { targetUserId: string }[]
}

export const userRestrictionRepository = {
  async create(data: CreateUserRestrictionData): Promise<UserRestrictionWithTargets> {
    const targetUserIds = [...new Set(data.targetUserIds ?? [])]
    return prisma.userRestriction.create({
      data: {
        userId: data.userId,
        type: data.type,
        restrictedUntil: data.restrictedUntil,
        reason: data.reason ?? null,
        reportId: data.reportId ?? null,
        createdByAdminId: data.createdByAdminId,
        ...(targetUserIds.length > 0
          ? {
              targets: {
                create: targetUserIds.map((targetUserId) => ({ targetUserId })),
              },
            }
          : {}),
      },
      include: targetsInclude,
    })
  },

  /** Active = not cleared and restrictedUntil in the future. */
  async findActiveByUser(userId: string): Promise<UserRestrictionWithTargets[]> {
    const now = new Date()
    return prismaRead.userRestriction.findMany({
      where: {
        userId,
        clearedAt: null,
        restrictedUntil: { gt: now },
      },
      include: targetsInclude,
      orderBy: { createdAt: 'desc' },
    })
  },

  async findActiveByUserAndType(
    userId: string,
    type: UserRestrictionType,
  ): Promise<UserRestrictionWithTargets | null> {
    const now = new Date()
    return prismaRead.userRestriction.findFirst({
      where: {
        userId,
        type,
        clearedAt: null,
        restrictedUntil: { gt: now },
      },
      include: targetsInclude,
      orderBy: { restrictedUntil: 'desc' },
    })
  },

  async listByUser(userId: string, includeCleared: boolean): Promise<UserRestrictionWithTargets[]> {
    return prismaRead.userRestriction.findMany({
      where: {
        userId,
        ...(includeCleared ? {} : { clearedAt: null }),
      },
      include: targetsInclude,
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  },

  async findById(id: string): Promise<UserRestrictionWithTargets | null> {
    return prismaRead.userRestriction.findUnique({
      where: { id },
      include: targetsInclude,
    })
  },

  async clear(id: string, clearedByAdminId: string): Promise<UserRestrictionWithTargets> {
    return prisma.userRestriction.update({
      where: { id },
      data: {
        clearedAt: new Date(),
        clearedByAdminId,
      },
      include: targetsInclude,
    })
  },

  /** Soft-clear every active row of this type for the user (extend/replace pattern). */
  async clearActiveOfType(
    userId: string,
    type: UserRestrictionType,
    clearedByAdminId: string,
  ): Promise<number> {
    const now = new Date()
    const result = await prisma.userRestriction.updateMany({
      where: {
        userId,
        type,
        clearedAt: null,
        restrictedUntil: { gt: now },
      },
      data: {
        clearedAt: now,
        clearedByAdminId,
      },
    })
    return result.count
  },
}
