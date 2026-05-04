import { prisma, prismaRead } from '../config/database'
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

  /**
   * Find the most recent VIP assignment for a user regardless of active/expired status.
   * Used to surface last VIP dates even after expiry.
   */
  async findMostRecent(userId: string): Promise<UserVipAssignment | null> {
    return prisma.userVipAssignment.findFirst({
      where: { userId },
      orderBy: { startsAt: 'desc' },
    })
  },

  /**
   * All rare-public-ID assignments for inventory/history views (e.g. GET store/my-items).
   * Optional `isActive` matches `user_vip_assignments.is_active` (expiry job sets false).
   */
  async findAllForUser(
    userId: string,
    opts: { isActive?: boolean },
  ): Promise<
    Array<
      UserVipAssignment & {
        vipPublicId: {
          tier: string
          rarityScore: number
          priceCredits: number | null
          matchedRules: string[]
        }
      }
    >
  > {
    return prismaRead.userVipAssignment.findMany({
      where: {
        userId,
        ...(opts.isActive !== undefined ? { isActive: opts.isActive } : {}),
      },
      include: {
        vipPublicId: {
          select: {
            tier: true,
            rarityScore: true,
            priceCredits: true,
            matchedRules: true,
          },
        },
      },
      orderBy: { startsAt: 'desc' },
    })
  },
}
