import { randomBytes } from 'crypto'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { deviceRepository } from '../repositories/device.repository'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { userRepository } from '../repositories/user.repository'
import { bannedDeviceRepository } from '../repositories/bannedDevice.repository'
import { passwordService } from './password.service'
import { sessionService } from './session.service'
import { meService } from './me.service'
import { auditService } from './audit.service'
import { faceVerificationAdminService } from './face-verification-admin.service'
import { agencyHostService } from './agencyHost.service'
import { deviceBanService } from './device-ban.service'
import { storageService } from './storage.service'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { explainFaceProfileStatus } from '../utils/face-profile-status'

function generateTemporaryPassword(): string {
  const suffix = randomBytes(9)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, 'a')
  return `Aa1!${suffix}9`
}

export const adminUserModerationService = {
  async resetPassword(params: { targetUserId: string; adminUserId: string; newPassword?: string }) {
    const user = await userRepository.findById(params.targetUserId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const plain = params.newPassword?.trim() || generateTemporaryPassword()
    const strength = passwordService.validateStrength(plain)
    if (!strength.ok) {
      throw new AppError(400, strength.error, 'WEAK_PASSWORD')
    }

    const passwordHash = await passwordService.hash(plain)
    await prisma.$transaction(async (tx) => {
      await tx.authPassword.upsert({
        where: { userId: params.targetUserId },
        create: { userId: params.targetUserId, passwordHash, previousPasswordHashes: [] },
        update: { passwordHash, lastChangedAt: new Date() },
      })
      await tx.user.update({
        where: { id: params.targetUserId },
        data: { passwordSet: true },
      })
    })

    // revokeAllSessions already bumps users.token_version + busts the Redis TV cache.
    await sessionService.revokeAllSessions(params.targetUserId)

    auditService.log({
      userId: params.adminUserId,
      actionType: 'ADMIN_PASSWORD_RESET',
      actionStatus: 'success',
      actionDetails: { targetUserId: params.targetUserId, sessionsRevoked: true },
    })

    return {
      ok: true as const,
      userId: params.targetUserId,
      temporaryPassword: params.newPassword ? undefined : plain,
      message: 'Password reset; all sessions revoked',
    }
  },

  async getFaceVerificationStatus(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [profile, kyc, isFaceVerified] = await Promise.all([
      faceVerificationRepository.getProfileByUserId(userId),
      agencyApplicationKycRepository.getKycByUserId(userId),
      faceVerificationRepository.isVerifiedForUser(userId),
    ])

    let referenceImageUrl: string | null = null
    const refKey = profile?.s3KeyReference?.trim()
    if (refKey) {
      try {
        referenceImageUrl = storageService.getCdnOrS3PublicUrl(refKey)
      } catch {
        referenceImageUrl = null
      }
    }

    const relatedIds = [
      ...new Set(
        [profile?.duplicateOfUserId, profile?.matchedUserId].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ]
    const relatedRows =
      relatedIds.length > 0 ? await userRepository.findDisplayRowsByIds(relatedIds) : []
    const relatedById = new Map(relatedRows.map((u) => [u.id, u]))

    const toUserSummary = (id: string | null | undefined) => {
      if (!id) return null
      const u = relatedById.get(id)
      if (!u) return null
      return {
        userId: u.id,
        username: u.username,
        name: formatUserName(u),
        avatarUrl: u.avatarUrl,
        publicId: String(u.publicId),
        displayPublicId: resolveDisplayPublicId(u),
      }
    }

    const duplicateOfUser = toUserSummary(profile?.duplicateOfUserId)
    const matchedUser = toUserSummary(profile?.matchedUserId)
    const hasReferenceImage = Boolean(refKey)
    const isIndexed = Boolean(
      profile?.status === 'INDEXED' &&
        profile.rekognitionFaceId?.trim() &&
        profile.s3KeyReference?.trim(),
    )
    const kycFaceVerified = Boolean(kyc?.faceVerified)
    const explanation = explainFaceProfileStatus({
      status: profile?.status,
      failureReason: profile?.failureReason,
      hasReferenceImage,
      kycFaceVerified,
      isIndexed,
      faceMatchSimilarity: profile?.faceMatchSimilarity,
      matchedUserName: matchedUser?.name || matchedUser?.username || duplicateOfUser?.name,
    })

    return {
      userId,
      isFaceVerified,
      kycFaceVerified,
      hasReferenceImage,
      statusLabel: explanation.statusLabel,
      statusDetail: explanation.statusDetail,
      notIndexedReason: explanation.notIndexedReason,
      profile: profile
        ? {
            faceProfileId: profile.id,
            status: profile.status,
            rekognitionFaceId: profile.rekognitionFaceId,
            collectionId: profile.collectionId,
            indexedAt: profile.indexedAt?.toISOString() ?? null,
            lastVerifiedAt: profile.lastVerifiedAt?.toISOString() ?? null,
            revokedAt: profile.revokedAt?.toISOString() ?? null,
            failureReason: profile.failureReason,
            imageQualityScore: profile.imageQualityScore,
            livenessConfidence: profile.livenessConfidence,
            faceMatchSimilarity: profile.faceMatchSimilarity,
            qualityChecksPassed: profile.qualityChecksPassed,
            detectedGender: profile.detectedGender,
            hasReferenceImage,
            isIndexed,
            statusLabel: explanation.statusLabel,
            statusDetail: explanation.statusDetail,
            notIndexedReason: explanation.notIndexedReason,
            duplicateOfUserId: profile.duplicateOfUserId,
            matchedUserId: profile.matchedUserId,
            duplicateOfUser,
            matchedUser,
            referenceImageUrl,
          }
        : null,
    }
  },

  async revokeFaceVerification(params: {
    targetUserId: string
    adminUserId: string
    reason?: string
    revokeRelated?: boolean
  }) {
    return faceVerificationAdminService.revokeUserFaceProfile(
      params.targetUserId,
      params.adminUserId,
      params.reason,
      { revokeRelated: params.revokeRelated },
    )
  },

  async removeAvatar(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    await userRepository.updateProfile(userId, { avatarUrl: null })
    await meService.invalidateUserCaches(userId)

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_AVATAR_REMOVED',
      actionStatus: 'success',
      actionDetails: { targetUserId: userId },
    })

    return { ok: true as const, userId, avatarUrl: null }
  },

  async removeBio(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    await userRepository.updateProfile(userId, { bio: null })
    await meService.invalidateUserCaches(userId)

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_BIO_REMOVED',
      actionStatus: 'success',
      actionDetails: { targetUserId: userId },
    })

    return { ok: true as const, userId, bio: null }
  },

  async resetDisplayIdentity(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const username = `user_${user.publicId.toString()}`
    await userRepository.update(userId, {
      username,
      firstName: null,
      lastName: null,
      usernameUpdatedAt: new Date(),
    })
    await meService.invalidateUserCaches(userId)

    auditService.log({
      userId: adminUserId,
      actionType: 'ADMIN_IDENTITY_RESET',
      actionStatus: 'success',
      actionDetails: { targetUserId: userId, username },
    })

    return {
      ok: true as const,
      userId,
      username,
      firstName: null,
      lastName: null,
    }
  },

  async removeFromAgency(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')
    if (user.isAgent) {
      throw new AppError(
        400,
        'User is an agency owner; cannot remove from agency as a host',
        'USER_IS_AGENCY_OWNER',
      )
    }

    return agencyHostService.adminRemoveHostFromAgency(userId, adminUserId)
  },

  async listUserDevices(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const [devices, bans] = await Promise.all([
      deviceRepository.findByUserId(userId),
      bannedDeviceRepository.listByRelatedUserId(userId),
    ])
    const bannedSet = new Set(bans.map((b: { deviceId: string }) => b.deviceId))

    return {
      userId,
      devices: devices.map((d: (typeof devices)[number]) => ({
        registryId: d.id,
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        platform: d.platform,
        lastActiveAt: d.lastActiveAt.toISOString(),
        loginAt: d.loginAt.toISOString(),
        ipAddress: d.ipAddress,
        isBanned: bannedSet.has(d.deviceId),
      })),
    }
  },

  async banUserDevices(params: {
    userId: string
    adminUserId: string
    deviceId?: string
    reason?: string
  }) {
    const user = await userRepository.findById(params.userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    let deviceIds: string[]
    if (params.deviceId?.trim()) {
      const row = await deviceRepository.findByUserIdAndDeviceId(
        params.userId,
        params.deviceId.trim(),
      )
      if (!row) {
        throw new AppError(404, 'Device not registered for this user', 'DEVICE_NOT_FOUND')
      }
      deviceIds = [row.deviceId]
    } else {
      const devices = await deviceRepository.findByUserId(params.userId)
      deviceIds = devices.map((d) => d.deviceId)
      if (deviceIds.length === 0) {
        throw new AppError(404, 'No devices found for user', 'DEVICE_NOT_FOUND')
      }
    }

    const results = []
    for (const deviceId of deviceIds) {
      results.push(
        await deviceBanService.banDevice({
          deviceId,
          adminUserId: params.adminUserId,
          reason: params.reason,
          relatedUserId: params.userId,
        }),
      )
    }

    return { ok: true as const, userId: params.userId, banned: results }
  },

  async unbanDevice(deviceId: string, adminUserId: string) {
    return deviceBanService.unbanDevice(deviceId, adminUserId)
  },
}
