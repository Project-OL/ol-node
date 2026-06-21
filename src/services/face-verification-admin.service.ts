import type { FaceProfileStatus } from '@prisma/client'
import { env } from '../config/env'
import { AppError } from '../middlewares/errorHandler'
import {
  deleteFaceFromCollection,
  describeFaceCollection,
  externalImageIdToUserId,
  listFacesInCollection,
} from '../lib/rekognition.client'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { auditService } from './audit.service'

async function deleteRekognitionFaceSafe(
  faceId: string | null | undefined,
  deletedFaces: Set<string>,
): Promise<void> {
  if (!faceId?.trim()) return
  if (deletedFaces.has(faceId)) return
  try {
    await deleteFaceFromCollection(faceId)
    deletedFaces.add(faceId)
  } catch (error) {
    if ((error as { name?: string }).name !== 'InvalidParameterException') {
      throw error
    }
    deletedFaces.add(faceId)
  }
}

function formatUserName(input: {
  firstName: string | null
  lastName: string | null
  username: string | null
}): string {
  const name = [input.firstName, input.lastName].filter(Boolean).join(' ').trim()
  return name || input.username || 'Unknown'
}

function formatDisplayPublicId(input: {
  publicId: bigint | null
  currentVipPublicId: bigint | null
}): string | null {
  if (input.currentVipPublicId != null) return String(input.currentVipPublicId)
  if (input.publicId != null) return String(input.publicId)
  return null
}

function serializeDbProfile(
  profile: Awaited<ReturnType<typeof faceVerificationRepository.listProfilesForAdmin>>['items'][0],
) {
  return {
    id: profile.id,
    userId: profile.userId,
    userName: formatUserName(profile.user),
    displayPublicId: formatDisplayPublicId(profile.user),
    status: profile.status,
    collectionId: profile.collectionId,
    rekognitionFaceId: profile.rekognitionFaceId,
    duplicateOfUserId: profile.duplicateOfUserId,
    matchedUserId: profile.matchedUserId,
    matchedUserName: profile.matchedUser ? formatUserName(profile.matchedUser) : null,
    s3KeyReference: profile.s3KeyReference,
    imageQualityScore: profile.imageQualityScore,
    livenessConfidence: profile.livenessConfidence,
    faceMatchSimilarity: profile.faceMatchSimilarity,
    failureReason: profile.failureReason,
    indexedAt: profile.indexedAt?.toISOString() ?? null,
    lastVerifiedAt: profile.lastVerifiedAt?.toISOString() ?? null,
    revokedAt: profile.revokedAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  }
}

type RevokeOneResult = {
  userId: string
  previousStatus: string
  revokedAt: string
  skipped: boolean
}

async function revokeOneUserFaceProfile(
  targetUserId: string,
  adminUserId: string,
  deletedFaces: Set<string>,
  reason?: string,
): Promise<RevokeOneResult> {
  const profile = await faceVerificationRepository.getProfileByUserId(targetUserId)
  if (!profile) {
    return {
      userId: targetUserId,
      previousStatus: 'NONE',
      revokedAt: new Date().toISOString(),
      skipped: true,
    }
  }
  if (profile.status === 'REVOKED') {
    return {
      userId: targetUserId,
      previousStatus: 'REVOKED',
      revokedAt: profile.revokedAt?.toISOString() ?? new Date().toISOString(),
      skipped: true,
    }
  }

  if (profile.status === 'INDEXED' && profile.rekognitionFaceId) {
    await deleteRekognitionFaceSafe(profile.rekognitionFaceId, deletedFaces)
  }

  await faceVerificationRepository.revokeProfile({ userId: targetUserId })
  await faceVerificationRepository.createRevocationRecord({
    userId: targetUserId,
    faceProfileId: profile.id,
    revokedByUserId: adminUserId,
    revokeReason: reason ?? null,
    rekognitionFaceId: profile.rekognitionFaceId,
  })

  const kyc = await agencyApplicationKycRepository.getKycByUserId(targetUserId)
  if (kyc?.faceVerified) {
    await agencyApplicationKycRepository.setFaceVerified(targetUserId, false)
  }

  auditService.log({
    userId: targetUserId,
    actionType: 'face_profile_admin_revoked',
    actionStatus: 'success',
    actionDetails: { adminUserId, reason: reason ?? null, previousStatus: profile.status },
  })

  return {
    userId: targetUserId,
    previousStatus: profile.status,
    revokedAt: new Date().toISOString(),
    skipped: false,
  }
}

export const faceVerificationAdminService = {
  async listDbProfiles(input: {
    page?: number
    limit?: number
    status?: FaceProfileStatus
    includeRevoked?: boolean
  }) {
    const page = Math.max(1, input.page ?? 1)
    const limit = Math.min(100, Math.max(1, input.limit ?? 20))
    const result = await faceVerificationRepository.listProfilesForAdmin({
      page,
      limit,
      status: input.status,
      includeRevoked: input.includeRevoked,
    })

    return {
      collectionId: env.REKOGNITION_COLLECTION_ID,
      page: result.page,
      limit: result.limit,
      total: result.total,
      profiles: result.items.map(serializeDbProfile),
    }
  },

  async listCollectionFaces(input: { limit?: number; nextToken?: string }) {
    const limit = Math.min(4096, Math.max(1, input.limit ?? 100))
    const [collectionMeta, listResult] = await Promise.all([
      describeFaceCollection().catch(() => null),
      listFacesInCollection({ maxResults: limit, nextToken: input.nextToken }),
    ])

    const faces = listResult.Faces ?? []
    const faceIds = faces.map((f) => f.FaceId).filter((id): id is string => Boolean(id))
    const externalUserIds = faces
      .map((f) => (f.ExternalImageId ? externalImageIdToUserId(f.ExternalImageId) : null))
      .filter((id): id is string => Boolean(id))

    const [byFaceId, byUserId] = await Promise.all([
      faceVerificationRepository.findProfilesByRekognitionFaceIds(faceIds),
      faceVerificationRepository.findProfilesByUserIds(externalUserIds),
    ])

    const profileByFaceId = new Map(byFaceId.map((p) => [p.rekognitionFaceId!, p]))
    const profileByUserId = new Map(byUserId.map((p) => [p.userId, p]))

    const mappedFaces = faces.map((face) => {
      const faceId = face.FaceId ?? null
      const externalImageId = face.ExternalImageId ?? null
      const userIdFromExternal = externalImageId ? externalImageIdToUserId(externalImageId) : null
      const dbProfile =
        (faceId ? profileByFaceId.get(faceId) : undefined) ??
        (userIdFromExternal ? profileByUserId.get(userIdFromExternal) : undefined) ??
        null

      return {
        faceId,
        externalImageId,
        userIdFromExternal,
        confidence: face.Confidence ?? null,
        imageId: face.ImageId ?? null,
        dbProfile: dbProfile
          ? {
              userId: dbProfile.userId,
              userName: formatUserName(dbProfile.user),
              displayPublicId: formatDisplayPublicId(dbProfile.user),
              status: dbProfile.status,
              rekognitionFaceId: dbProfile.rekognitionFaceId,
              matchedUserId: dbProfile.matchedUserId,
              duplicateOfUserId: dbProfile.duplicateOfUserId,
            }
          : null,
        syncStatus: dbProfile
          ? dbProfile.status === 'INDEXED' && dbProfile.rekognitionFaceId === faceId
            ? 'linked'
            : 'db_mismatch'
          : 'orphaned_in_collection',
      }
    })

    return {
      collectionId: env.REKOGNITION_COLLECTION_ID,
      faceCount: collectionMeta?.FaceCount ?? null,
      facesReturned: mappedFaces.length,
      nextToken: listResult.NextToken ?? null,
      faces: mappedFaces,
    }
  },

  async getInventorySummary() {
    const [statusCounts, collectionMeta] = await Promise.all([
      faceVerificationRepository.countProfilesByStatus(),
      describeFaceCollection().catch(() => null),
    ])

    return {
      collectionId: env.REKOGNITION_COLLECTION_ID,
      collectionFaceCount: collectionMeta?.FaceCount ?? null,
      dbProfilesByStatus: Object.fromEntries(
        statusCounts.map((row) => [row.status, row._count._all]),
      ),
    }
  },

  /**
   * Remove face from Rekognition (when indexed) and mark profile REVOKED.
   * By default also revokes DUPLICATE_FACE / related profiles pointing at this user.
   */
  async revokeUserFaceProfile(
    targetUserId: string,
    adminUserId: string,
    reason?: string,
    options?: { revokeRelated?: boolean },
  ): Promise<{
    success: true
    revokedAt: string
    message: string
    previousStatus: string
    primary: RevokeOneResult
    relatedRevoked: RevokeOneResult[]
  }> {
    const primaryProfile = await faceVerificationRepository.getProfileByUserId(targetUserId)
    if (!primaryProfile) {
      throw new AppError(404, 'No face profile found for user', 'FACE_PROFILE_NOT_FOUND')
    }

    const deletedFaces = new Set<string>()
    const revokeRelated = options?.revokeRelated !== false
    const related = revokeRelated
      ? await faceVerificationRepository.findRelatedProfiles(targetUserId)
      : []

    const userIds = [targetUserId, ...related.map((r) => r.userId)]
    const results: RevokeOneResult[] = []
    for (const uid of userIds) {
      results.push(await revokeOneUserFaceProfile(uid, adminUserId, deletedFaces, reason))
    }

    const primary = results[0]!
    const relatedRevoked = results.slice(1)
    const anyRevoked = results.some((r) => !r.skipped)

    return {
      success: true,
      revokedAt: primary.revokedAt,
      message: anyRevoked
        ? `Face profile(s) revoked (${results.filter((r) => !r.skipped).length} user(s)). Users may register again.`
        : 'Face profile was already revoked.',
      previousStatus: primary.previousStatus,
      primary,
      relatedRevoked,
    }
  },

  async revokeByRekognitionFaceId(
    rekognitionFaceId: string,
    adminUserId: string,
    reason?: string,
    options?: { revokeRelated?: boolean },
  ) {
    const profile = await faceVerificationRepository.findProfileByRekognitionFaceIdAnyStatus(
      rekognitionFaceId,
    )

    if (profile) {
      return this.revokeUserFaceProfile(profile.userId, adminUserId, reason, options)
    }

    const deletedFaces = new Set<string>()
    await deleteRekognitionFaceSafe(rekognitionFaceId, deletedFaces)

    auditService.log({
      userId: null,
      actionType: 'face_profile_collection_orphan_deleted',
      actionStatus: 'success',
      actionDetails: { adminUserId, rekognitionFaceId, reason: reason ?? null },
    })

    return {
      success: true as const,
      revokedAt: new Date().toISOString(),
      message: 'Face removed from Rekognition collection (no linked DB profile).',
      primary: {
        userId: '',
        previousStatus: 'NONE',
        revokedAt: new Date().toISOString(),
        skipped: false,
      },
      relatedRevoked: [] as RevokeOneResult[],
      rekognitionFaceId,
    }
  },

  async deleteFromCollectionOnly(
    targetUserId: string,
    adminUserId: string,
  ): Promise<{ success: true; message: string }> {
    const profile = await faceVerificationRepository.getProfileByUserId(targetUserId)
    if (!profile?.rekognitionFaceId) {
      throw new AppError(404, 'No Rekognition face id for user', 'FACE_PROFILE_NOT_FOUND')
    }

    await deleteFaceFromCollection(profile.rekognitionFaceId)

    auditService.log({
      userId: targetUserId,
      actionType: 'face_profile_collection_only_deleted',
      actionStatus: 'success',
      actionDetails: { adminUserId, rekognitionFaceId: profile.rekognitionFaceId },
    })

    return {
      success: true,
      message: 'Face removed from Rekognition collection only; database profile unchanged.',
    }
  },

  /**
   * Resolve a duplicate registration: clear the blocked user's DUPLICATE_FACE row and
   * revoke the indexed owner's Rekognition face so both accounts can register again.
   */
  async resolveDuplicateIdentity(
    blockedUserId: string,
    adminUserId: string,
    reason?: string,
    revokeIndexedOwner = true,
  ): Promise<{
    success: true
    blockedUser: { userId: string; previousStatus: string; cleared: true }
    indexedOwner: { userId: string; revoked: boolean; previousStatus?: string } | null
    message: string
  }> {
    const blockedProfile = await faceVerificationRepository.getProfileByUserId(blockedUserId)
    if (!blockedProfile) {
      throw new AppError(404, 'No face profile found for blocked user', 'FACE_PROFILE_NOT_FOUND')
    }

    const ownerUserId =
      blockedProfile.matchedUserId ?? blockedProfile.duplicateOfUserId ?? null

    let indexedOwner: {
      userId: string
      revoked: boolean
      previousStatus?: string
    } | null = null

    if (ownerUserId && revokeIndexedOwner) {
      const ownerProfile = await faceVerificationRepository.getProfileByUserId(ownerUserId)
      if (ownerProfile?.status === 'INDEXED') {
        await this.revokeUserFaceProfile(
          ownerUserId,
          adminUserId,
          reason ?? `duplicate_resolution_for_${blockedUserId}`,
          { revokeRelated: false },
        )
        indexedOwner = {
          userId: ownerUserId,
          revoked: true,
          previousStatus: 'INDEXED',
        }
      } else if (ownerProfile) {
        indexedOwner = {
          userId: ownerUserId,
          revoked: false,
          previousStatus: ownerProfile.status,
        }
      }
    } else if (ownerUserId) {
      const ownerProfile = await faceVerificationRepository.getProfileByUserId(ownerUserId)
      indexedOwner = ownerProfile
        ? { userId: ownerUserId, revoked: false, previousStatus: ownerProfile.status }
        : null
    }

    if (blockedProfile.status === 'DUPLICATE_FACE') {
      await faceVerificationRepository.clearDuplicateBlock({ userId: blockedUserId })
    } else {
      await faceVerificationRepository.revokeProfile({ userId: blockedUserId })
    }

    await faceVerificationRepository.createRevocationRecord({
      userId: blockedUserId,
      faceProfileId: blockedProfile.id,
      revokedByUserId: adminUserId,
      revokeReason: reason ?? 'duplicate_identity_resolved',
      rekognitionFaceId: blockedProfile.rekognitionFaceId,
    })

    const blockedKyc = await agencyApplicationKycRepository.getKycByUserId(blockedUserId)
    if (blockedKyc?.faceVerified) {
      await agencyApplicationKycRepository.setFaceVerified(blockedUserId, false)
    }

    auditService.log({
      userId: blockedUserId,
      actionType: 'face_duplicate_identity_admin_resolved',
      actionStatus: 'success',
      actionDetails: {
        adminUserId,
        ownerUserId,
        ownerRevoked: indexedOwner?.revoked ?? false,
        reason: reason ?? null,
      },
    })

    return {
      success: true,
      blockedUser: {
        userId: blockedUserId,
        previousStatus: blockedProfile.status,
        cleared: true,
      },
      indexedOwner,
      message:
        'Duplicate block cleared for requesting user' +
        (indexedOwner?.revoked ? '; indexed owner face revoked in AWS and DB.' : '.'),
    }
  },
}
