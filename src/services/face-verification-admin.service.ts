import { randomUUID } from 'crypto'
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
import {
  faceRegistrationRepository,
  ATTENTION_NEEDED_STATUSES,
} from '../repositories/faceRegistration.repository'
import { redisClient, RedisKeys } from '../config/redis'
import { enqueueFaceRegistrationVerification } from '../queues/face-registration.queue'
import { mapPool } from '../utils/map-pool'
import { storageService } from './storage.service'
import { auditService } from './audit.service'
import { afterFaceProfileRevoked } from './face-profile-invalidate'

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

function toFailureImageUrl(key: string | null | undefined): string | null {
  if (!key?.trim()) return null
  try {
    return storageService.getCdnOrS3PublicUrl(key)
  } catch {
    return null
  }
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
    revokedByAdminId: adminUserId,
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

  // Keep login JWTs valid. Bust /me so faceVerified/faceStatus update immediately.
  await afterFaceProfileRevoked(targetUserId)

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
    const profile =
      await faceVerificationRepository.findProfileByRekognitionFaceIdAnyStatus(rekognitionFaceId)

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
   * Force-terminate every non-terminal `face_registration_sessions` row for a user
   * (PENDING/UPLOADED/PROCESSING/LIVENESS_PASSED/INDEX_PENDING) and clear the liveness
   * session/verify rate-limit + processing-lock Redis keys tied to those attempts.
   * For a user whose registration is stuck (worker outage mid-flight, or a client that
   * abandoned a session without calling /verify) — `GET /face-verification/me` prefers a
   * hung session's PENDING_INDEX status over the profile, and `POST /face-registration/session`
   * only auto-expires the earliest-stage statuses, so neither self-heals a session stuck
   * past LIVENESS_PASSED/INDEX_PENDING without this.
   */
  async clearStuckRegistrationSessions(
    targetUserId: string,
    adminUserId: string,
    reason?: string,
  ): Promise<{ success: true; clearedSessionIds: string[]; message: string }> {
    const failureReason = reason?.trim() ? `admin_cleared: ${reason.trim()}` : 'admin_cleared_stuck'
    const clearedSessionIds = await faceRegistrationRepository.clearStuckSessionsForUser(
      targetUserId,
      failureReason,
    )

    await redisClient.del(
      RedisKeys.faceRegistrationSessionRate(targetUserId),
      RedisKeys.faceRegistrationVerifyRate(targetUserId),
      RedisKeys.faceRegistrationLock(targetUserId),
    )

    auditService.log({
      userId: targetUserId,
      actionType: 'face_registration_sessions_admin_cleared',
      actionStatus: 'success',
      actionDetails: { adminUserId, reason: reason ?? null, clearedSessionIds },
    })

    return {
      success: true,
      clearedSessionIds,
      message:
        clearedSessionIds.length > 0
          ? `Cleared ${clearedSessionIds.length} stuck session(s) and reset rate limits. User can register again.`
          : 'No open sessions were stuck; rate limits and lock reset anyway.',
    }
  },

  /**
   * Bulk version of `clearStuckRegistrationSessions`: clears every user currently
   * matching the "needs attention" worklist (same filters as `listStuckRegistrationSessions`
   * -- `minAgeSec`/`userId`), not just one. Runs entirely server-side in a single request
   * rather than the caller looping individual clear calls, which is both far faster (bounded
   * concurrency via mapPool) and avoids hammering the API with hundreds of separate writes.
   *
   * Drains the worklist page-by-page: each successful clear removes that user from the
   * "needs attention" set, so re-fetching page 1 after each batch converges to empty on
   * its own. Capped at 200 iterations as a safety net against a pathological case where
   * something keeps re-qualifying mid-run (not expected in normal operation).
   */
  async clearAllStuckRegistrationSessions(
    adminUserId: string,
    input: { minAgeSec?: number; userId?: string; reason?: string },
  ): Promise<{
    success: true
    usersCleared: number
    sessionsCleared: number
    message: string
  }> {
    const minAgeSec = Math.max(0, input.minAgeSec ?? 5)
    const failureReason = input.reason?.trim()
      ? `admin_bulk_cleared: ${input.reason.trim()}`
      : 'admin_bulk_cleared_stuck'
    const batchSize = 100
    const concurrency = 10

    let usersCleared = 0
    let sessionsCleared = 0

    for (let guard = 0; guard < 200; guard++) {
      const { items } = await faceRegistrationRepository.listStuckSessions({
        minAgeSec,
        page: 1,
        limit: batchSize,
        userId: input.userId,
      })
      if (items.length === 0) break

      const results = await mapPool(items, concurrency, async (row) => {
        const clearedIds = await faceRegistrationRepository.clearStuckSessionsForUser(
          row.user_id,
          failureReason,
        )
        await redisClient.del(
          RedisKeys.faceRegistrationSessionRate(row.user_id),
          RedisKeys.faceRegistrationVerifyRate(row.user_id),
          RedisKeys.faceRegistrationLock(row.user_id),
        )
        return clearedIds.length
      })

      for (const clearedCount of results) {
        if (clearedCount > 0) {
          usersCleared += 1
          sessionsCleared += clearedCount
        }
      }

      if (items.length < batchSize) break
    }

    auditService.log({
      userId: null,
      actionType: 'face_registration_sessions_admin_bulk_cleared',
      actionStatus: 'success',
      actionDetails: {
        adminUserId,
        reason: input.reason ?? null,
        minAgeSec,
        scopedUserId: input.userId ?? null,
        usersCleared,
        sessionsCleared,
      },
    })

    return {
      success: true,
      usersCleared,
      sessionsCleared,
      message:
        usersCleared > 0
          ? `Cleared ${sessionsCleared} session(s) across ${usersCleared} user(s).`
          : 'Nothing matched the current filters.',
    }
  },

  /**
   * Paginated worklist of users whose MOST RECENT registration attempt still needs
   * attention — hung (non-terminal) or ended in a failure they haven't retried past
   * yet (LIVENESS_FAILED/VALIDATION_FAILED/REJECTED) — older than `minAgeSec`, across
   * all users (or scoped to one via `userId`). For admin triage: `recheckRegistrationSession`
   * (non-destructive, only works on hung sessions) or `clearStuckRegistrationSessions`
   * (force-expire + reset rate limits, safe on both hung and already-failed sessions) on each.
   */
  async listStuckRegistrationSessions(input: {
    minAgeSec?: number
    page?: number
    limit?: number
    userId?: string
  }) {
    const minAgeSec = Math.max(0, input.minAgeSec ?? 5)
    const page = Math.max(1, input.page ?? 1)
    const limit = Math.min(100, Math.max(1, input.limit ?? 20))
    const { items, total } = await faceRegistrationRepository.listStuckSessions({
      minAgeSec,
      page,
      limit,
      userId: input.userId,
    })
    const now = Date.now()
    return {
      minAgeSec,
      page,
      limit,
      total,
      sessions: items.map((s) => ({
        sessionId: s.id,
        userId: s.user_id,
        publicId: formatDisplayPublicId({
          publicId: s.public_id,
          currentVipPublicId: s.current_vip_public_id,
        }),
        name: formatUserName({
          firstName: s.first_name,
          lastName: s.last_name,
          username: s.username,
        }),
        status: s.status,
        awsSessionId: s.aws_session_id,
        riskScore: s.risk_score,
        failureReason: s.failure_reason,
        failureImageUrl: toFailureImageUrl(s.failure_image_s3_key),
        createdAt: s.created_at.toISOString(),
        updatedAt: s.updated_at.toISOString(),
        stuckForSec: Math.floor((now - s.created_at.getTime()) / 1000),
      })),
    }
  },

  /**
   * Every session for one user that still needs admin attention, with age — the
   * per-user-detail equivalent of `listStuckRegistrationSessions`. Prefers the open
   * (non-terminal) sessions; if there are none, falls back to the single latest
   * session when it ended in a failure the user hasn't retried past yet
   * (LIVENESS_FAILED/VALIDATION_FAILED/REJECTED) — same "needs attention" definition
   * as the global worklist, just scoped to one user instead of a DB-wide query.
   */
  async getOpenRegistrationSessionsForUser(targetUserId: string) {
    const open = await faceRegistrationRepository.findOpenSessionsForUser(targetUserId)
    const now = Date.now()
    const toRow = (s: {
      id: string
      status: string
      awsSessionId: string | null
      riskScore: number
      failureReason: string | null
      failureImageS3Key?: string | null
      createdAt: Date
      updatedAt: Date
    }) => ({
      sessionId: s.id,
      status: s.status,
      awsSessionId: s.awsSessionId,
      riskScore: s.riskScore,
      failureReason: s.failureReason,
      failureImageUrl: toFailureImageUrl(s.failureImageS3Key),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      stuckForSec: Math.floor((now - s.createdAt.getTime()) / 1000),
    })

    if (open.length > 0) return open.map(toRow)

    const latest = await faceRegistrationRepository.findLatestForUser(targetUserId)
    if (latest && (ATTENTION_NEEDED_STATUSES as string[]).includes(latest.status)) {
      return [toRow(latest)]
    }
    return []
  },

  /**
   * Non-destructive alternative to clearing: re-queue the BullMQ verify job for a
   * session right now instead of waiting for the client's next poll / the job's own
   * exponential backoff. Works for PENDING/UPLOADED (client finished the liveness SDK
   * but the app never called `/verify` — AWS already has the result waiting) and
   * PROCESSING (a job was enqueued but never completed, e.g. during the DB outage this
   * capability was built in response to). LIVENESS_PASSED/INDEX_PENDING are the
   * worker-face-index indexing pipeline's domain, not this queue — rejected with a
   * pointer to `clearStuckRegistrationSessions` instead.
   */
  async recheckRegistrationSession(
    targetUserId: string,
    sessionId: string,
    adminUserId: string,
  ): Promise<{ success: true; sessionId: string; message: string }> {
    const session = await faceRegistrationRepository.findByIdForUser(sessionId, targetUserId)
    if (!session) {
      throw new AppError(404, 'Registration session not found', 'FACE_REG_SESSION_NOT_FOUND')
    }
    if (session.status === 'LIVENESS_PASSED' || session.status === 'INDEX_PENDING') {
      throw new AppError(
        409,
        'Session already passed liveness and is awaiting indexing by worker-face-index, not the verify queue. If it is genuinely stuck, use the clear action instead.',
        'FACE_REG_SESSION_PAST_VERIFY_STAGE',
        { state: session.status },
      )
    }
    if (
      session.status !== 'PENDING' &&
      session.status !== 'UPLOADED' &&
      session.status !== 'PROCESSING'
    ) {
      throw new AppError(
        409,
        'Session is not in a re-checkable state',
        'FACE_REG_SESSION_INVALID_STATE',
        {
          state: session.status,
        },
      )
    }
    if (!session.awsSessionId) {
      throw new AppError(
        409,
        'Session has no AWS liveness session to check',
        'FACE_REG_SESSION_NO_AWS_SESSION',
      )
    }

    const idempotencyKey = randomUUID()
    await faceRegistrationRepository.updateSession(sessionId, {
      status: 'PROCESSING',
      idempotencyKey,
    })
    await faceRegistrationRepository.appendAudit({
      sessionId,
      userId: targetUserId,
      action: 'admin_verify_requeued',
      details: { adminUserId, idempotencyKey, previousStatus: session.status },
    })
    await enqueueFaceRegistrationVerification({ sessionId, userId: targetUserId, idempotencyKey })

    auditService.log({
      userId: targetUserId,
      actionType: 'face_registration_admin_recheck',
      actionStatus: 'success',
      actionDetails: { adminUserId, sessionId },
    })

    return {
      success: true,
      sessionId,
      message: 'Verify job re-queued. Poll GET /face-verification/me for the result.',
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

    const ownerUserId = blockedProfile.matchedUserId ?? blockedProfile.duplicateOfUserId ?? null

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
      revokedByAdminId: adminUserId,
      revokeReason: reason ?? 'duplicate_identity_resolved',
      rekognitionFaceId: blockedProfile.rekognitionFaceId,
    })

    const blockedKyc = await agencyApplicationKycRepository.getKycByUserId(blockedUserId)
    if (blockedKyc?.faceVerified) {
      await agencyApplicationKycRepository.setFaceVerified(blockedUserId, false)
    }

    await afterFaceProfileRevoked(blockedUserId)

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
