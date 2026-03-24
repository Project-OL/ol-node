import { prisma } from '../config/database'
import type { UserVipAssignment } from '@prisma/client'

export const vipAssignmentRepository = {
  /**
   * Find the currently active, non-expired assignment for a user.
   */
  async findActive(userId: string): Promise<UserVipAssignment | null> {
    return prisma.userVipAssignment.findFirst({
      where: {
        userId,
        isActive: true,
        expiresAt: { gt: new Date() },
        revokedAt: null,
      },
      orderBy: { startsAt: 'desc' },
    })
  },

  /**
   * Create a new assignment row.
   */
  async create(data: {
    userId: string
    publicId: bigint
    startsAt: Date
    expiresAt: Date
  }): Promise<UserVipAssignment> {
    return prisma.userVipAssignment.create({ data })
  },

  /**
   * Deactivate every active assignment for a user (idempotent).
   */
  async deactivateAll(userId: string): Promise<void> {
    await prisma.userVipAssignment.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false },
    })
  },

  /**
   * Revoke a specific assignment. Scoped to userId for security.
   */
  async revoke(assignmentId: string, userId: string): Promise<UserVipAssignment> {
    const existing = await prisma.userVipAssignment.findFirst({
      where: { id: assignmentId, userId },
    })
    if (!existing) {
      throw new Error('Assignment not found')
    }
    return prisma.userVipAssignment.update({
      where: { id: assignmentId },
      data: { revokedAt: new Date(), isActive: false },
    })
  },

  /**
   * Load assignment by ID, scoped to userId.
   */
  async findById(assignmentId: string, userId: string): Promise<UserVipAssignment | null> {
    return prisma.userVipAssignment.findFirst({
      where: { id: assignmentId, userId },
    })
  },
}
