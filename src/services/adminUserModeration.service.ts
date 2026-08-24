import { randomBytes } from 'crypto'
import { prisma } from '../config/database'
import { AppError } from '../middlewares/errorHandler'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { deviceRepository } from '../repositories/device.repository'
import { sessionRepository, MAX_SESSIONS_PER_USER } from '../repositories/session.repository'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { livePhotoRepository } from '../repositories/livePhoto.repository'
import { userRepository } from '../repositories/user.repository'
import { livePhotoService } from './livePhoto.service'
import { bannedDeviceRepository } from '../repositories/bannedDevice.repository'
import { passwordService } from './password.service'
import { securityPasswordService } from './security-password.service'
import { sessionService } from './session.service'
import { meService } from './me.service'
import { auditService } from './audit.service'
import { faceVerificationAdminService } from './face-verification-admin.service'
import { agencyHostService } from './agencyHost.service'
import { deviceBanService } from './device-ban.service'
import { storageService } from './storage.service'
import { formatUserName, resolveDisplayPublicId } from '../utils/user-display'
import { allocateUniqueUsername } from '../utils/user-identity-unique'
import { explainFaceProfileStatus } from '../utils/face-profile-status'
import { describeLivePhotoFailureReason, explainLivePhotoStatus } from '../utils/live-photo-status'
import { adminAuditMetaFromRequest } from '../utils/admin-audit'
import type { FastifyRequest } from 'fastify'

const OTHER_ACTIVE_LOGINS_PER_DEVICE = 50

function mapOtherActiveLogin(row: {
  id: string
  deviceName: string
  ipAddress: string
  lastActiveAt: Date
  loginType: string | null
  user: {
    id: string
    username: string
    firstName: string | null
    lastName: string | null
    publicId: bigint
    defaultPublicId: bigint
    currentVipPublicId: bigint | null
    avatarUrl: string | null
    status: string
  }
}) {
  return {
    userId: row.user.id,
    username: row.user.username,
    name: formatUserName(row.user),
    avatarUrl: row.user.avatarUrl,
    publicId: String(row.user.publicId),
    displayPublicId: resolveDisplayPublicId(row.user),
    status: String(row.user.status),
    sessionId: row.id,
    deviceName: row.deviceName,
    ipAddress: row.ipAddress,
    lastActiveAt: row.lastActiveAt.toISOString(),
    loginType: row.loginType,
  }
}

function generateTemporaryPassword(): string {
  const suffix = randomBytes(9)
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, 'a')
  return `Aa1!${suffix}9`
}

function safePublicUrl(key: string): string | null {
  try {
    return storageService.getCdnOrS3PublicUrl(key)
  } catch {
    return null
  }
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

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.targetUserId,
      actionType: 'ADMIN_PASSWORD_RESET',
      actionStatus: 'success',
      actionDetails: { sessionsRevoked: true },
    })

    return {
      ok: true as const,
      userId: params.targetUserId,
      temporaryPassword: params.newPassword ? undefined : plain,
      message: 'Password reset; all sessions revoked',
    }
  },

  async setSecurityPassword(params: { targetUserId: string; adminUserId: string; pin: string }) {
    const user = await userRepository.findById(params.targetUserId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const result = await securityPasswordService.adminSetPin(params.targetUserId, params.pin)

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.targetUserId,
      actionType: 'ADMIN_SECURITY_PASSWORD_SET',
      actionStatus: 'success',
      actionDetails: { overwritten: result.overwritten },
    })

    return {
      ok: true as const,
      userId: params.targetUserId,
      overwritten: result.overwritten,
      setAt: result.setAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
      message: result.overwritten ? 'Security password overwritten' : 'Security password set',
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
        [profile?.duplicateOfUserId, profile?.matchedUserId].filter((id): id is string =>
          Boolean(id),
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

  async getLivePhotoStatus(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const row = await livePhotoRepository.findByUserId(userId)
    const latestAttempt = row ? await livePhotoRepository.findLatestAttempt(row.id) : null

    const primaryKey = row?.s3Key?.trim() || ''
    const pendingKey = row?.pendingS3Key?.trim() || ''
    const hasUploadedImage = Boolean(primaryKey || pendingKey || row?.imageUrl?.trim())
    const hasVerifiedPhotoFields =
      row != null &&
      row.verifiedAt != null &&
      (Boolean(row.imageUrl?.trim()) || Boolean(primaryKey))
    const replaceInProgress = Boolean(
      pendingKey ||
      row?.verificationState === 'PENDING_VERIFICATION' ||
      (row?.verificationState === 'PROCESSING' && hasVerifiedPhotoFields),
    )
    const isVerified =
      row?.verificationState === 'VERIFIED' ||
      (hasVerifiedPhotoFields &&
        (row?.verificationState === 'PENDING_VERIFICATION' ||
          row?.verificationState === 'PROCESSING'))

    const imageUrl = row?.imageUrl?.trim() || (primaryKey ? safePublicUrl(primaryKey) : null)
    const pendingImageUrl = pendingKey ? safePublicUrl(pendingKey) : null

    const failureReason =
      row?.failedReason?.trim() ||
      (row?.verificationState === 'FAILED' || row?.verificationState === 'REJECTED'
        ? latestAttempt?.failureReason?.trim() || null
        : null) ||
      null
    const replaceFailedReason = row?.replaceFailedReason?.trim() || null

    const explanation = explainLivePhotoStatus({
      verificationState: row?.verificationState,
      failedReason: failureReason,
      replaceFailedReason,
      hasUploadedImage,
      isVerified,
      replaceInProgress,
      similarityScore: row?.similarityScore,
    })

    return {
      userId,
      hasLivePhoto: hasUploadedImage,
      isVerified,
      verificationState: row?.verificationState ?? 'NOT_UPLOADED',
      statusLabel: explanation.statusLabel,
      statusDetail: explanation.statusDetail,
      verdictReason: explanation.verdictReason,
      failureReason,
      failureReasonDetail: describeLivePhotoFailureReason(failureReason),
      replaceFailedReason,
      replaceFailedReasonDetail: describeLivePhotoFailureReason(replaceFailedReason),
      replaceInProgress,
      similarityScore: row?.similarityScore ?? null,
      verifiedAt: row?.verifiedAt?.toISOString() ?? null,
      imageUrl,
      pendingImageUrl,
      latestAttempt: latestAttempt
        ? {
            matched: latestAttempt.matched,
            failureReason: latestAttempt.failureReason,
            failureReasonDetail: describeLivePhotoFailureReason(latestAttempt.failureReason),
            similarityScore: latestAttempt.similarityScore,
            createdAt: latestAttempt.createdAt.toISOString(),
          }
        : null,
    }
  },

  async removeLivePhoto(params: {
    targetUserId: string
    adminUserId: string
    reason?: string
    request?: FastifyRequest
  }) {
    const user = await userRepository.findById(params.targetUserId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const row = await livePhotoRepository.findByUserId(params.targetUserId)
    const hasPhoto = Boolean(
      row &&
      (row.s3Key.trim() ||
        row.pendingS3Key?.trim() ||
        row.imageUrl?.trim() ||
        (row.verificationState !== 'NOT_UPLOADED' && row.verificationState !== 'PENDING_UPLOAD')),
    )
    if (!row || !hasPhoto) {
      throw new AppError(404, 'Live photo not found', 'LIVE_PHOTO_NOT_FOUND')
    }

    const previousState = row.verificationState
    await livePhotoService.remove(params.targetUserId)

    auditService.logAdmin({
      adminUserId: params.adminUserId,
      targetUserId: params.targetUserId,
      actionType: 'ADMIN_LIVE_PHOTO_REMOVED',
      actionStatus: 'success',
      actionDetails: {
        reason: params.reason ?? null,
        previousState,
        wasVerified: previousState === 'VERIFIED' || row.verifiedAt != null,
      },
      destination: `Live photo ${params.targetUserId}`,
      request: params.request ? adminAuditMetaFromRequest(params.request) : undefined,
    })

    return { ok: true as const, userId: params.targetUserId }
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

    auditService.logAdmin({
      adminUserId,
      targetUserId: userId,
      actionType: 'ADMIN_AVATAR_REMOVED',
      actionStatus: 'success',
    })

    return { ok: true as const, userId, avatarUrl: null }
  },

  async removeBio(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    await userRepository.updateProfile(userId, { bio: null })
    await meService.invalidateUserCaches(userId)

    auditService.logAdmin({
      adminUserId,
      targetUserId: userId,
      actionType: 'ADMIN_BIO_REMOVED',
      actionStatus: 'success',
    })

    return { ok: true as const, userId, bio: null }
  },

  async resetDisplayIdentity(userId: string, adminUserId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const username = await allocateUniqueUsername(`user_${user.publicId.toString()}`)
    await userRepository.update(userId, {
      username,
      firstName: null,
      lastName: null,
      usernameUpdatedAt: new Date(),
    })
    await meService.invalidateUserCaches(userId)

    auditService.logAdmin({
      adminUserId,
      targetUserId: userId,
      actionType: 'ADMIN_IDENTITY_RESET',
      actionStatus: 'success',
      actionDetails: { username },
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

    const [devices, bans, sessions] = await Promise.all([
      deviceRepository.findByUserId(userId),
      bannedDeviceRepository.listByRelatedUserId(userId),
      sessionRepository.findActiveByUserId(userId),
    ])
    const bannedSet = new Set(bans.map((b: { deviceId: string }) => b.deviceId))
    const sessionByDeviceId = new Map(sessions.map((s) => [s.deviceId, s]))
    const deviceIds = [
      ...new Set(
        [...devices.map((d) => d.deviceId), ...sessions.map((s) => s.deviceId)].filter(Boolean),
      ),
    ]
    const otherSessions = await sessionRepository.findActiveOnDeviceIdsExcludingUser(
      deviceIds,
      userId,
    )
    const otherByDevice = new Map<string, ReturnType<typeof mapOtherActiveLogin>[]>()
    const seenUserOnDevice = new Set<string>()
    for (const row of otherSessions) {
      const key = `${row.deviceId}:${row.userId}`
      if (seenUserOnDevice.has(key)) continue
      seenUserOnDevice.add(key)
      const list = otherByDevice.get(row.deviceId) ?? []
      if (list.length >= OTHER_ACTIVE_LOGINS_PER_DEVICE) continue
      list.push(mapOtherActiveLogin(row))
      otherByDevice.set(row.deviceId, list)
    }
    const otherActiveUserIds = new Set(otherSessions.map((s) => s.userId))

    return {
      userId,
      maxActiveSessions: MAX_SESSIONS_PER_USER,
      activeSessionCount: sessions.length,
      otherActiveLoginCount: otherActiveUserIds.size,
      activeSessions: sessions.map((s) => ({
        sessionId: s.id,
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        ipAddress: s.ipAddress,
        lastActiveAt: s.lastActiveAt.toISOString(),
        loginType: s.loginType ?? null,
        expiresAt: s.expiresAt.toISOString(),
        otherActiveLogins: otherByDevice.get(s.deviceId) ?? [],
      })),
      devices: devices.map((d: (typeof devices)[number]) => {
        const session = sessionByDeviceId.get(d.deviceId)
        return {
          registryId: d.id,
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          platform: d.platform,
          lastActiveAt: d.lastActiveAt.toISOString(),
          loginAt: d.loginAt.toISOString(),
          ipAddress: d.ipAddress,
          isBanned: bannedSet.has(d.deviceId),
          hasActiveSession: Boolean(session),
          sessionId: session?.id ?? null,
          loginType: session?.loginType ?? null,
          otherActiveLogins: otherByDevice.get(d.deviceId) ?? [],
        }
      }),
    }
  },

  async logoutAllSessions(userId: string) {
    const user = await userRepository.findById(userId)
    if (!user) throw new AppError(404, 'User not found', 'USER_NOT_FOUND')

    const sessions = await sessionRepository.findActiveByUserId(userId)
    await sessionService.revokeAllSessions(userId)
    return {
      ok: true as const,
      userId,
      revokedSessionCount: sessions.length,
      message:
        sessions.length === 0
          ? 'No active sessions'
          : `Logged out ${sessions.length} device${sessions.length === 1 ? '' : 's'}`,
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
