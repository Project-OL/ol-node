import { AppError } from '../middlewares/errorHandler'
import { deleteFaceFromCollection } from '../lib/rekognition.client'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { auditService } from './audit.service'

async function deleteRekognitionFaceSafe(faceId: string | null | undefined): Promise<void> {
  if (!faceId?.trim()) return
  try {
    await deleteFaceFromCollection(faceId)
  } catch (error) {
    if ((error as { name?: string }).name !== 'InvalidParameterException') {
      throw error
    }
  }
}

export const faceVerificationAdminService = {
  /**
   * Remove face from Rekognition (when indexed) and mark profile REVOKED.
   * Works for INDEXED, DUPLICATE_FACE, FAILED, and PENDING_INDEX profiles.
   */
  async revokeUserFaceProfile(
    targetUserId: string,
    adminUserId: string,
    reason?: string,
  ): Promise<{ success: true; revokedAt: string; message: string; previousStatus: string }> {
    const profile = await faceVerificationRepository.getProfileByUserId(targetUserId)
    if (!profile) {
      throw new AppError(404, 'No face profile found for user', 'FACE_PROFILE_NOT_FOUND')
    }
    if (profile.status === 'REVOKED') {
      return {
        success: true,
        revokedAt: profile.revokedAt?.toISOString() ?? new Date().toISOString(),
        message: 'Face profile was already revoked.',
        previousStatus: 'REVOKED',
      }
    }

    if (profile.status === 'INDEXED' && profile.rekognitionFaceId) {
      await deleteRekognitionFaceSafe(profile.rekognitionFaceId)
    }

    await faceVerificationRepository.revokeProfile({ userId: targetUserId })
    await faceVerificationRepository.createRevocationRecord({
      userId: targetUserId,
      faceProfileId: profile.id,
      revokedByUserId: adminUserId,
      revokeReason: reason ?? null,
      rekognitionFaceId: profile.rekognitionFaceId,
    })

    auditService.log({
      userId: targetUserId,
      actionType: 'face_profile_admin_revoked',
      actionStatus: 'success',
      actionDetails: { adminUserId, reason: reason ?? null, previousStatus: profile.status },
    })

    const revokedAt = new Date().toISOString()
    return {
      success: true,
      revokedAt,
      message: 'Face profile revoked. User may register again.',
      previousStatus: profile.status,
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
