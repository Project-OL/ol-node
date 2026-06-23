import fs from 'fs/promises'
import path from 'path'
import { prisma, prismaRead } from '../config/database'
import { withDbRetry } from '../utils/prismaRetry'
import { auditRepository } from './audit.repository'
import type { UserStatus } from '../models/types'

const ACCOUNT_ARCHIVE_DIR = path.join(process.cwd(), 'data', 'account-archives')

export const userRepository = {
  async create(data: {
    username: string
    publicId: bigint
    defaultPublicId: bigint
    status?: UserStatus
    lastIpAddress?: string | null
  }) {
    return prisma.user.create({
      data: {
        username: data.username,
        publicId: data.publicId,
        defaultPublicId: data.defaultPublicId,
        status: data.status ?? 'new',
        lastIpAddress: data.lastIpAddress ?? undefined,
      },
    })
  },

  async findById(id: string) {
    return withDbRetry(prismaRead, () =>
      prismaRead.user.findUnique({
        where: { id },
        include: {
          authIdentifiers: true,
          authPassword: true,
        },
      }),
    )
  },

  async isAgentUser(id: string): Promise<boolean> {
    const row = await withDbRetry(prismaRead, () =>
      prismaRead.user.findUnique({
        where: { id },
        select: { isAgent: true },
      }),
    )
    return row?.isAgent === true
  },

  async findFirstSupportUser() {
    return prismaRead.user.findFirst({
      where: { isSupport: true, status: 'active' },
      select: { id: true, publicId: true },
      orderBy: { createdAt: 'asc' },
    })
  },

  /**
   * Resolve a user by any externally visible numeric ID:
   * - users.public_id (base)
   * - users.default_public_id
   * - users.current_vip_public_id (active rare overlay)
   */
  async findByPublicId(publicId: number) {
    const pid = BigInt(publicId)
    return prismaRead.user.findFirst({
      where: {
        OR: [{ publicId: pid }, { defaultPublicId: pid }, { currentVipPublicId: pid }],
      },
      include: { authIdentifiers: true, authPassword: true },
    })
  },

  /** Lean row for GET/PATCH /me (read replica). */
  async findForMe(userId: string) {
    return prismaRead.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        publicId: true,
        defaultPublicId: true,
        currentVipPublicId: true,
        firstName: true,
        lastName: true,
        gender: true,
        dateOfBirth: true,
        country: true,
        avatarUrl: true,
        bio: true,
        usernameUpdatedAt: true,
        passwordSet: true,
        isSupport: true,
        adminTags: true,
        authIdentifiers: {
          select: { provider: true, identifier: true, isPrimary: true },
          orderBy: [{ isPrimary: 'desc' }, { provider: 'asc' }],
        },
      },
    })
  },

  async updateProfile(
    id: string,
    data: {
      firstName?: string
      lastName?: string | null
      dateOfBirth?: Date | null
      country?: string | null
      gender?: string | null
      avatarUrl?: string | null
      bio?: string | null
      usernameUpdatedAt?: Date | null
      status?: UserStatus
      profileCompletedAt?: Date | null
      lastIpAddress?: string | null
    },
  ) {
    return prisma.user.update({
      where: { id },
      data,
    })
  },

  async updatePasswordSet(id: string, passwordSet: boolean) {
    return prisma.user.update({
      where: { id },
      data: { passwordSet },
    })
  },

  async updateLastIp(id: string, ip: string | null) {
    return prisma.user.update({
      where: { id },
      data: { lastIpAddress: ip ?? undefined },
    })
  },

  async getTokenVersion(id: string): Promise<number | null> {
    const u = await prismaRead.user.findUnique({
      where: { id },
      select: { tokenVersion: true },
    })
    return u?.tokenVersion ?? null
  },

  /** Bump global access invalidation (revoke-all, password change). Returns new version. */
  async incrementTokenVersion(id: string): Promise<number> {
    const u = await prisma.user.update({
      where: { id },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    })
    return u.tokenVersion
  },

  async update(
    id: string,
    data: {
      vipSubscriptionActive?: boolean
      vipSubscriptionStartAt?: Date | null
      vipSubscriptionExpiresAt?: Date | null
      privacyInvisibleVisitor?: boolean
      privacyMysteryLive?: boolean
      privacyMysteryRank?: boolean
      privacyInvisibleOnline?: boolean
      privacyUpdatedAt?: Date | null
      status?: string
      suspendedUntil?: Date | null
      username?: string
      firstName?: string | null
      lastName?: string | null
      dateOfBirth?: Date | null
      country?: string | null
      gender?: string | null
      avatarUrl?: string | null
      lastIpAddress?: string | null
      [key: string]: unknown
    },
  ) {
    return prisma.user.update({
      where: { id },
      data,
    })
  },

  /**
   * Permanently delete account: archive data (GDPR), then in one transaction clear PII,
   * delete auth/sessions/devices/OTP, release VIP, set status deleted, finalize AccountDeletion.
   */
  async deleteAccountPermanently(userId: string, deletionId: string): Promise<void> {
    const now = new Date()

    const user = await prismaRead.user.findUnique({
      where: { id: userId },
      include: {
        authIdentifiers: true,
        authPassword: true,
        securityPassword: true,
        accountDeletion: true,
      },
    })
    if (!user) return

    const archivePayload = {
      userId: user.id,
      username: user.username,
      publicId: String(user.publicId),
      firstName: user.firstName,
      lastName: user.lastName,
      dateOfBirth: user.dateOfBirth?.toISOString(),
      country: user.country,
      gender: user.gender,
      avatarUrl: user.avatarUrl,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      authIdentifiers: user.authIdentifiers.map((a) => ({
        provider: a.provider,
        identifier: a.identifier,
        isVerified: a.isVerified,
      })),
      accountDeletion: user.accountDeletion
        ? {
            scheduledAt: user.accountDeletion.scheduledAt.toISOString(),
            deactivationUntil: user.accountDeletion.deactivationUntil.toISOString(),
            deletionAt: user.accountDeletion.deletionAt.toISOString(),
            reason: user.accountDeletion.reason,
          }
        : null,
      archivedAt: now.toISOString(),
    }
    const dataSize = JSON.stringify(archivePayload).length
    let archiveLocation: string | null = null
    try {
      await fs.mkdir(ACCOUNT_ARCHIVE_DIR, { recursive: true })
      const filename = `${userId}-${now.getTime()}.json`
      archiveLocation = path.join(ACCOUNT_ARCHIVE_DIR, filename)
      await fs.writeFile(archiveLocation, JSON.stringify(archivePayload, null, 2), 'utf8')
    } catch (err) {
      console.error('[AccountDeletion] Archive write failed:', err)
    }

    await auditRepository.log({
      userId,
      actionType: 'ACCOUNT_DATA_ARCHIVED',
      actionStatus: 'success',
      actionDetails: {
        archiveLocation: archiveLocation ?? 'none',
        dataSize,
        deletedAt: now.toISOString(),
      },
    })

    const followEdges = await prismaRead.userFollow.findMany({
      where: { OR: [{ followerId: userId }, { followingId: userId }] },
      select: { followerId: true, followingId: true },
    })

    await prisma.$transaction(async (tx) => {
      const { agencyHostService } = await import('../services/agencyHost.service')
      await agencyHostService.handleHostAccountDeletion(userId, tx)
      await agencyHostService.handleAgentAccountDeletion(userId, tx)

      await tx.authIdentifier.deleteMany({ where: { userId } })
      await tx.authPassword.deleteMany({ where: { userId } })
      await tx.securityPassword.deleteMany({ where: { userId } })
      await tx.session.deleteMany({ where: { userId } })
      await tx.deviceRegistry.deleteMany({ where: { userId } })
      await tx.otpToken.deleteMany({ where: { userId } })
      await tx.vipPublicId.updateMany({
        where: { currentOwnerId: userId },
        data: { currentOwnerId: null },
      })
      await tx.user.update({
        where: { id: userId },
        data: {
          firstName: null,
          lastName: null,
          dateOfBirth: null,
          country: null,
          gender: null,
          avatarUrl: null,
          lastIpAddress: null,
          status: 'deleted',
        },
      })
      await tx.accountDeletion.update({
        where: { id: deletionId },
        data: { isDeleted: true, deletedAt: now },
      })
      await tx.auditLog.create({
        data: {
          userId,
          actionType: 'ACCOUNT_PERMANENTLY_DELETED',
          actionStatus: 'success',
          actionDetails: {
            originalCreatedAt: user.createdAt.toISOString(),
            deletedAt: now.toISOString(),
            dataSize,
            archiveLocation: archiveLocation ?? undefined,
          },
        },
      })
    })

    const { invalidateSocialCountsCache } = await import('../services/follow.service')
    const affectedUserIds = new Set<string>([userId])
    for (const edge of followEdges) {
      affectedUserIds.add(edge.followerId)
      affectedUserIds.add(edge.followingId)
    }
    await invalidateSocialCountsCache(...affectedUserIds)
  },

  /** Raw privacy toggles for read-gate composition (bulk). */
  async findPrivacyFlagsBulk(userIds: string[]) {
    if (userIds.length === 0) return []
    return prismaRead.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        privacyInvisibleVisitor: true,
        privacyMysteryLive: true,
        privacyMysteryRank: true,
        privacyInvisibleOnline: true,
      },
    })
  },

  async setIsTagged(userId: string, isTagged: boolean) {
    return prisma.user.update({
      where: { id: userId },
      data: { isTagged },
      select: { id: true, isTagged: true },
    })
  },

  async setAdminTags(userId: string, adminTags: string[]) {
    return prisma.user.update({
      where: { id: userId },
      data: { adminTags },
      select: { id: true, adminTags: true },
    })
  },
}
