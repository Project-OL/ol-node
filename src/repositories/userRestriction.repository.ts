import type { UserRestriction, UserRestrictionType } from '@prisma/client'
import { prisma, prismaRead } from '../config/database'

export type CreateUserRestrictionData = {
  userId: string
  type: UserRestrictionType
  restrictedUntil: Date
  reason?: string | null
  reportId?: string | null
  createdByAdminId: string
}

export const userRestrictionRepository = {
  async create(data: CreateUserRestrictionData): Promise<UserRestriction> {
    return prisma.userRestriction.create({
      data: {
        userId: data.userId,
        type: data.type,
        restrictedUntil: data.restrictedUntil,
        reason: data.reason ?? null,
        reportId: data.reportId ?? null,
        createdByAdminId: data.createdByAdminId,
      },
    })
  },

  /** Active = not cleared and restrictedUntil in the future. */
  async findActiveByUser(userId: string): Promise<UserRestriction[]> {
    const now = new Date()
    return prismaRead.userRestriction.findMany({
      where: {
        userId,
        clearedAt: null,
        restrictedUntil: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  async findActiveByUserAndType(
    userId: string,
    type: UserRestrictionType,
  ): Promise<UserRestriction | null> {
    const now = new Date()
    return prismaRead.userRestriction.findFirst({
      where: {
        userId,
        type,
        clearedAt: null,
        restrictedUntil: { gt: now },
      },
      orderBy: { restrictedUntil: 'desc' },
    })
  },

  async listByUser(userId: string, includeCleared: boolean): Promise<UserRestriction[]> {
    return prismaRead.userRestriction.findMany({
      where: {
        userId,
        ...(includeCleared ? {} : { clearedAt: null }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  },

  async findById(id: string): Promise<UserRestriction | null> {
    return prismaRead.userRestriction.findUnique({ where: { id } })
  },

  async clear(id: string, clearedByAdminId: string): Promise<UserRestriction> {
    return prisma.userRestriction.update({
      where: { id },
      data: {
        clearedAt: new Date(),
        clearedByAdminId,
      },
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
