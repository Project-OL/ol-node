import { prisma, prismaRead } from '../config/database'
import type { AccountDeletion } from '@prisma/client'

export const accountDeletionRepository = {
  async findByUserId(userId: string): Promise<AccountDeletion | null> {
    return prismaRead.accountDeletion.findUnique({
      where: { userId },
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

  async update(
    id: string,
    data: {
      isCancelled?: boolean
      cancelledAt?: Date | null
      isDeleted?: boolean
      deletedAt?: Date | null
    },
  ): Promise<AccountDeletion> {
    return prisma.accountDeletion.update({
      where: { id },
      data,
    })
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
}
