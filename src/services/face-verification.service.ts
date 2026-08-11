import { randomUUID } from 'crypto'
import type { FaceVerificationDecision, Prisma } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { storageService } from './storage.service'
import { redisClient, RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import {
  deleteFaceFromCollection,
  indexUserFace,
  searchFaceInCollection,
} from '../lib/rekognition.client'
import { auditService } from './audit.service'
import { agencyApplicationKycRepository } from '../repositories/agencyApplicationKyc.repository'
import { faceRegistrationService } from './faceRegistration.service'
import { faceRegistrationValidationService } from './face-registration/face-registration.validation.service'
import { faceLivenessConfigService } from './faceLivenessConfig.service'
import { FACE_REGISTRATION_ERRORS } from '../constants/face-registration-errors'
import { buildDuplicateMatchDetails } from './face-registration/face-duplicate-match.service'

const RATE_LIMIT_LUA = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
`

const faceMetrics = {
  indexingQueued: 0,
  indexingCompleted: 0,
  indexingFailed: 0,
}

type RequestCtx = { ip?: string; headers?: Record<string, string | string[] | undefined> }

function toHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]
  return value
}

function extractIp(ctx: RequestCtx): string | undefined {
  const xff = toHeaderString(ctx.headers?.['x-forwarded-for'])
  if (xff) return xff.split(',')[0]?.trim()
  return ctx.ip
}

async function applyRateLimit(key: string, max: number, windowSec: number) {
  const count = Number(await redisClient.eval(RATE_LIMIT_LUA, 1, key, String(windowSec)))
  if (count > max) {
    throw new AppError(
      429,
      `Too many attempts. Try again in ${windowSec} seconds.`,
      'RATE_LIMITED',
      {
        retryAfter: windowSec,
      },
    )
  }
}

function validateUserOwnedS3Key(type: 'register' | 'verify', userId: string, s3Key: string) {
  const prefix = `face/${type}/${userId}/`
  if (!s3Key.startsWith(prefix)) {
    throw new AppError(400, 'Invalid image key for user', 'face_invalid_s3_key')
  }
}

async function getImageBytes(s3Key: string): Promise<Buffer> {
  return storageService.getObjectBuffer(s3Key)
}

export const faceVerificationService = {
  async createRegistrationUploadUrl(userId: string) {
    const clientRequestId = randomUUID()
    const s3Key = `face/register/${userId}/${randomUUID()}.jpg`
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, 'image/jpeg', 300)
    return { uploadUrl, s3Key, expiresInSec: 300, clientRequestId }
  },

  async createVerificationUploadUrl(userId: string) {
    const clientRequestId = randomUUID()
    const s3Key = `face/verify/${userId}/${randomUUID()}.jpg`
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, 'image/jpeg', 300)
    return { uploadUrl, s3Key, expiresInSec: 300, clientRequestId }
  },

  async registerFromUploadedKey(
    userId: string,
    body: { s3Key: string; clientRequestId: string },
    ctx: RequestCtx,
  ) {
    if (await faceLivenessConfigService.isLivenessRequired()) {
      throw new AppError(
        403,
        'Face Liveness registration is required. Use POST /api/v1/face-registration/session with Amplify Face Liveness.',
        'FACE_LIVENESS_REQUIRED',
      )
    }

    const lockKey = RedisKeys.faceRegisterLock(userId)
    const locked = await redisClient.set(lockKey, '1', 'EX', 30, 'NX')
    if (!locked) {
      throw new AppError(409, 'Face register already in progress', 'face_register_in_progress')
    }
    try {
      await applyRateLimit(
        RedisKeys.faceRegisterRateLimit(userId),
        env.FACE_REGISTER_RATE_PER_HOUR,
        3600,
      )

      const idemKey = RedisKeys.faceRegisterIdem(userId, body.clientRequestId)
      const idemHit = await redisClient.get(idemKey)
      if (idemHit) return JSON.parse(idemHit)

      validateUserOwnedS3Key('register', userId, body.s3Key)
      const imageBytes = await getImageBytes(body.s3Key)
      const validation = await faceRegistrationValidationService.runFullValidationPipeline(
        new Uint8Array(imageBytes),
        userId,
        { checkMinorAge: true, checkDuplicate: true, livenessPassed: false },
      )
      if (!validation.isValid) {
        if (validation.errorCode === FACE_REGISTRATION_ERRORS.FACE_DUPLICATE_IDENTITY) {
          await faceVerificationRepository.markDuplicate({
            userId,
            collectionId: env.REKOGNITION_COLLECTION_ID,
            s3KeyReference: body.s3Key,
            qualityScore: validation.qualityScore ?? null,
            duplicateOfUserId: validation.duplicateMatch?.matchedUserId ?? null,
            faceMatchSimilarity: validation.duplicateMatch?.matchSimilarity ?? null,
            moderationLabels: validation.moderationLabels as Prisma.InputJsonValue | null,
            qualityChecksPassed: validation.qualityChecksPassed as Prisma.InputJsonValue | null,
          })
          auditService.log({
            userId,
            actionType: 'face_register_duplicate_rejected',
            actionStatus: 'failed',
            actionDetails: {
              similarity: validation.duplicateMatch?.matchSimilarity,
              duplicateOfUserId: validation.duplicateMatch?.matchedUserId ?? 'unknown',
              matchedUser: validation.duplicateMatch?.matchedUser,
            },
            ipAddress: extractIp(ctx),
            userAgent: toHeaderString(ctx.headers?.['user-agent']),
          })
          throw faceRegistrationValidationService.toAppError(validation)
        }
        throw faceRegistrationValidationService.toAppError(validation)
      }
      const qualityScore = validation.qualityScore ?? 0

      const profile = await faceVerificationRepository.createPendingProfile({
        userId,
        collectionId: env.REKOGNITION_COLLECTION_ID,
        s3KeyReference: body.s3Key,
        qualityScore,
        qualityChecksPassed: validation.qualityChecksPassed as Prisma.InputJsonValue | null,
        detectedGender: validation.detectedGender ?? null,
        genderUpdatedAt: validation.genderUpdated ? new Date() : null,
        moderationLabels: validation.moderationLabels as Prisma.InputJsonValue | null,
      })

      faceMetrics.indexingQueued += 1
      auditService.log({
        userId,
        actionType: 'face_register_pending_index',
        actionStatus: 'success',
        actionDetails: { faceProfileId: profile.id },
        ipAddress: extractIp(ctx),
        userAgent: toHeaderString(ctx.headers?.['user-agent']),
      })

      const response = { status: 'PENDING_INDEX' as const, faceProfileId: profile.id }
      await redisClient.set(idemKey, JSON.stringify(response), 'EX', 24 * 60 * 60)
      return response
    } finally {
      await redisClient.del(lockKey)
    }
  },

  async verifyFromUploadedKey(
    userId: string,
    body: { s3Key: string; clientRequestId: string },
    ctx: RequestCtx,
  ) {
    const ip = extractIp(ctx)
    await applyRateLimit(
      RedisKeys.faceVerifyRateLimitUser(userId),
      env.FACE_VERIFY_RATE_PER_HOUR,
      3600,
    )
    if (ip) {
      await applyRateLimit(RedisKeys.faceVerifyRateLimitIp(ip), 30, 24 * 60 * 60)
    }

    const idemKey = RedisKeys.faceVerifyIdem(userId, body.clientRequestId)
    const idemHit = await redisClient.get(idemKey)
    if (idemHit) return JSON.parse(idemHit)

    const profile = await faceVerificationRepository.getProfileByUserId(userId)
    if (!profile || profile.status !== 'INDEXED' || !profile.rekognitionFaceId) {
      const attempt = await faceVerificationRepository.recordAttempt({
        userId,
        s3Key: body.s3Key,
        decision: 'ERROR',
        reason: 'profile_not_ready',
        latencyMs: 0,
        ipAddress: ip,
        userAgent: toHeaderString(ctx.headers?.['user-agent']),
        clientRequestId: body.clientRequestId,
      })
      return {
        decision: 'ERROR',
        similarityScore: 0,
        threshold: env.FACE_MATCH_THRESHOLD_PASS,
        attemptId: attempt.id,
      }
    }

    validateUserOwnedS3Key('verify', userId, body.s3Key)
    const startedAt = Date.now()
    let decision: FaceVerificationDecision = 'FAIL'
    let similarityScore = 0
    let reason: string | undefined
    let rekognitionRequestId: string | undefined
    try {
      const imageBytes = await getImageBytes(body.s3Key)
      const validation = await faceRegistrationValidationService.validateImageQuality(
        new Uint8Array(imageBytes),
        { checkMinorAge: false, livenessPassed: false },
      )
      if (!validation.isValid) {
        await faceVerificationRepository.recordAttempt({
          userId,
          s3Key: body.s3Key,
          decision: 'QUALITY_REJECTED',
          reason: validation.failure?.code,
          latencyMs: Date.now() - startedAt,
          ipAddress: ip,
          userAgent: toHeaderString(ctx.headers?.['user-agent']),
          clientRequestId: body.clientRequestId,
        })
        throw faceRegistrationValidationService.toAppError({
          isValid: false,
          errorCode: validation.failure?.code,
          details: validation.failure,
        })
      }

      const nudity = await faceRegistrationValidationService.checkForNudity(body.s3Key)
      if (nudity.isNudityDetected) {
        await faceVerificationRepository.recordAttempt({
          userId,
          s3Key: body.s3Key,
          decision: 'QUALITY_REJECTED',
          reason: 'FACE_QUALITY_INDECENT',
          latencyMs: Date.now() - startedAt,
          ipAddress: ip,
          userAgent: toHeaderString(ctx.headers?.['user-agent']),
          clientRequestId: body.clientRequestId,
        })
        throw new AppError(
          409,
          'Image does not meet our content guidelines.',
          'FACE_QUALITY_INDECENT',
        )
      }

      const top = await searchFaceInCollection({
        imageBytes,
        collectionId: env.REKOGNITION_COLLECTION_ID,
        threshold: Number(env.FACE_MATCH_THRESHOLD_REJECT),
      })
      rekognitionRequestId = top?.requestId
      const topFaceId = top?.faceId
      similarityScore = Number(top?.similarity ?? 0)

      if (!topFaceId) {
        decision = 'FAIL'
        reason = 'no_match'
      } else if (topFaceId !== profile.rekognitionFaceId) {
        decision = 'FAIL'
        reason = 'face_mismatch_other_user'
        auditService.log({
          userId,
          actionType: 'face_verify_cross_user_match',
          actionStatus: 'failed',
          actionDetails: {},
          ipAddress: ip,
          userAgent: toHeaderString(ctx.headers?.['user-agent']),
        })
      } else if (similarityScore >= env.FACE_MATCH_THRESHOLD_PASS) {
        decision = 'PASS'
      } else {
        decision = 'FAIL'
        reason = 'below_pass_threshold'
      }
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new AppError(504, 'Face service timeout', 'face_service_timeout')
      }
      throw new AppError(503, 'Face service unavailable', 'face_service_unavailable')
    }

    const attempt = await faceVerificationRepository.recordAttempt({
      userId,
      s3Key: body.s3Key,
      decision,
      similarityScore,
      reason,
      rekognitionRequestId,
      latencyMs: Date.now() - startedAt,
      ipAddress: ip,
      userAgent: toHeaderString(ctx.headers?.['user-agent']),
      clientRequestId: body.clientRequestId,
    })

    if (decision === 'PASS') {
      await faceVerificationRepository.touchLastVerifiedAt(userId)
      await redisClient.set(RedisKeys.faceVerifyLastPass(userId), '1', 'EX', 60)
      auditService.log({
        userId,
        actionType: 'face_verify_pass',
        actionStatus: 'success',
        actionDetails: { attemptId: attempt.id },
        ipAddress: ip,
        userAgent: toHeaderString(ctx.headers?.['user-agent']),
      })
      try {
        await agencyApplicationKycRepository.setFaceVerified(userId, true)
      } catch {
        /* non-fatal — KYC upsert edge cases */
      }
    }

    const response = {
      decision,
      similarityScore,
      threshold: env.FACE_MATCH_THRESHOLD_PASS,
      attemptId: attempt.id,
    }
    await redisClient.set(idemKey, JSON.stringify(response), 'EX', 60)
    return response
  },

  async getMyFaceProfile(userId: string) {
    const profile = await faceVerificationRepository.getProfileByUserId(userId)
    const status = profile?.status ?? 'REVOKED'
    const isDuplicate = String(status) === 'DUPLICATE_FACE'

    let referenceImageUrl: string | null = null
    const refKey = profile?.s3KeyReference?.trim()
    if (refKey) {
      try {
        referenceImageUrl = storageService.getCdnOrS3PublicUrl(refKey)
      } catch {
        referenceImageUrl = null
      }
    }

    let duplicateMatch: Awaited<ReturnType<typeof buildDuplicateMatchDetails>> | null = null
    if (isDuplicate && profile) {
      duplicateMatch = await buildDuplicateMatchDetails({
        matchedUserId: profile.matchedUserId ?? profile.duplicateOfUserId,
        matchSimilarity: profile.faceMatchSimilarity,
      })
    }

    return {
      status,
      message: isDuplicate
        ? 'Registration rejected: this face is already associated with another account.'
        : undefined,
      faceProfileId: profile?.id ?? null,
      canReRegister: status === 'FAILED' || status === 'REVOKED',
      indexedAt: profile?.indexedAt?.toISOString() ?? null,
      lastVerifiedAt: profile?.lastVerifiedAt?.toISOString() ?? null,
      hasReference: Boolean(profile?.s3KeyReference),
      referenceImageUrl,
      detectedGender: profile?.detectedGender ?? null,
      genderAutoUpdatedAt: profile?.genderUpdatedAt?.toISOString() ?? null,
      qualityChecksPassed: profile?.qualityChecksPassed ?? null,
      duplicateMatch: isDuplicate ? duplicateMatch : null,
    }
  },

  async revokeMyFaceProfile(userId: string) {
    const profile = await faceVerificationRepository.getProfileByUserId(userId)
    if (!profile) return { revoked: true as const }

    if (profile.rekognitionFaceId) {
      try {
        await deleteFaceFromCollection(profile.rekognitionFaceId)
      } catch (error) {
        if ((error as { name?: string }).name !== 'InvalidParameterException') {
          console.warn('[face] delete face failed', { userId, err: error })
        }
      }
    }
    await faceVerificationRepository.revokeProfile({ userId })
    auditService.log({ userId, actionType: 'face_profile_revoked', actionStatus: 'success' })
    return { revoked: true as const }
  },

  async createLivenessSession(userId: string) {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
    return {
      sessionId: `stub-${userId}-${randomUUID()}`,
      region: env.AWS_REGION,
      expiresAtIso: expiresAt.toISOString(),
      message:
        'Legacy stub. Use POST /api/v1/face-registration/session for Amazon Face Liveness (see docs/flow-md/face-registration-flow.md).',
    }
  },

  async processIndexingJob(payload: { userId: string; faceProfileId: string; s3Key: string }) {
    const profile = await faceVerificationRepository.getProfileByUserId(payload.userId)
    if (!profile || profile.id !== payload.faceProfileId || profile.status !== 'PENDING_INDEX') {
      return
    }
    try {
      const imageBytes = await getImageBytes(payload.s3Key)
      const preIndexMatch = await searchFaceInCollection({
        imageBytes,
        collectionId: env.REKOGNITION_COLLECTION_ID,
        threshold: Number(env.FACE_MATCH_THRESHOLD_PASS),
      })
      if (preIndexMatch) {
        const ownerProfile = await faceVerificationRepository.findProfileByRekognitionFaceId(
          preIndexMatch.faceId,
        )
        if (!ownerProfile || ownerProfile.userId !== payload.userId) {
          const duplicateOfUserId = ownerProfile?.userId ?? null
          const duplicateDetails = await buildDuplicateMatchDetails({
            matchedUserId: duplicateOfUserId,
            matchSimilarity: preIndexMatch.similarity,
          })
          await faceVerificationRepository.markDuplicate({
            userId: payload.userId,
            collectionId: env.REKOGNITION_COLLECTION_ID,
            s3KeyReference: payload.s3Key,
            duplicateOfUserId,
            faceMatchSimilarity: preIndexMatch.similarity,
          })
          auditService.log({
            userId: payload.userId,
            actionType: 'face_index_duplicate_rejected_at_index',
            actionStatus: 'failed',
            actionDetails: {
              similarity: preIndexMatch.similarity,
              duplicateOfUserId: duplicateOfUserId ?? 'unknown',
              matchedUser: duplicateDetails.matchedUser,
            },
          })
          return
        }
      }
      const indexRes = await indexUserFace({ userId: payload.userId, imageBytes })
      const faceId = indexRes.FaceRecords?.[0]?.Face?.FaceId
      if (!faceId) {
        await faceVerificationRepository.markProfileFailed({
          userId: payload.userId,
          reason: 'no_face_indexed',
        })
        faceMetrics.indexingFailed += 1
        return
      }
      await faceVerificationRepository.markProfileIndexed({
        userId: payload.userId,
        rekognitionFaceId: faceId,
      })
      faceMetrics.indexingCompleted += 1
      auditService.log({
        userId: payload.userId,
        actionType: 'face_profile_indexed',
        actionStatus: 'success',
      })
      await faceRegistrationService.onFaceProfileIndexed(payload.userId).catch(() => {
        /* non-fatal: registration session may not exist */
      })
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new AppError(504, 'Face service timeout', 'face_service_timeout')
      }
      throw error
    }
  },
}
