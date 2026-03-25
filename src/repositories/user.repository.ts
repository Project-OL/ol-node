import fs from 'fs/promises'
import path from 'path'
import { prisma, prismaRead } from '../config/database'
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
    return prismaRead.user.findUnique({
      where: { id },
      include: {
        authIdentifiers: true,
        authPassword: true,
      },
    })
  },

  async findByPublicId(publicId: number) {
    return prismaRead.user.findUnique({
      where: { publicId: BigInt(publicId) },
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
        firstName: true,
        lastName: true,
        gender: true,
        avatarUrl: true,
        bio: true,
        usernameUpdatedAt: true,
        passwordSet: true,
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
      country?: string
      gender?: string
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

    await prisma.$transaction(async (tx) => {
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
  },
}
