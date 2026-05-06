import { randomUUID } from 'crypto'
import type { FaceVerificationDecision } from '@prisma/client'
import { AppError } from '../middlewares/errorHandler'
import { storageService } from './storage.service'
import { redisClient, RedisKeys } from '../config/redis'
import { env } from '../config/env'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { enqueueFaceIndexingJob } from '../queues/face.queue'
import {
  deleteFaceFromCollection,
  detectFacesQuality,
  indexUserFace,
  searchFaceByImage,
} from '../lib/rekognition.client'
import { auditService } from './audit.service'

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
    throw new AppError(429, `Too many attempts. Try again in ${windowSec} seconds.`, 'RATE_LIMITED', {
      retryAfter: windowSec,
    })
  }
}

function validateUserOwnedS3Key(type: 'register' | 'verify', userId: string, s3Key: string) {
  const prefix = `face/${type}/${userId}/`
  if (!s3Key.startsWith(prefix)) {
    throw new AppError(400, 'Invalid image key for user', 'face_invalid_s3_key')
  }
}

function parseQuality(face: NonNullable<Awaited<ReturnType<typeof detectFacesQuality>>['FaceDetails']>[number]) {
  const brightness = face.Quality?.Brightness ?? 0
  const sharpness = face.Quality?.Sharpness ?? 0
  const confidence = face.Confidence ?? 0
  if (confidence < env.FACE_MIN_DETECT_CONFIDENCE) {
    throw new AppError(400, 'Face confidence too low', 'face_quality_rejected')
  }
  if ((face.Sunglasses?.Value ?? false) && (face.Sunglasses?.Confidence ?? 0) > 90) {
    throw new AppError(400, 'Sunglasses are not allowed', 'face_quality_rejected')
  }
  if (!(face.EyesOpen?.Value ?? true) && (face.EyesOpen?.Confidence ?? 0) > 90) {
    throw new AppError(400, 'Eyes must be open', 'face_quality_rejected')
  }
  if (brightness < 30 || sharpness < 30) {
    throw new AppError(400, 'Image quality too low', 'face_quality_rejected')
  }
  return (brightness + sharpness) / 2
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
      const detectRes = await detectFacesQuality(imageBytes)
      if ((detectRes.FaceDetails?.length ?? 0) !== 1) {
        throw new AppError(400, 'Exactly one face required', 'face_quality_rejected')
      }
      const qualityScore = parseQuality(detectRes.FaceDetails![0]!)

      const profile = await faceVerificationRepository.createPendingProfile({
        userId,
        collectionId: env.REKOGNITION_COLLECTION_ID,
        s3KeyReference: body.s3Key,
        qualityScore,
      })

      await enqueueFaceIndexingJob({ userId, faceProfileId: profile.id, s3Key: body.s3Key })
      faceMetrics.indexingQueued += 1
      auditService.log({
        userId,
        actionType: 'face_register_queued',
        actionStatus: 'success',
        actionDetails: { faceProfileId: profile.id },
        ipAddress: extractIp(ctx),
        userAgent: toHeaderString(ctx.headers?.['user-agent']),
      })

      const response = { status: 'PENDING_INDEX', faceProfileId: profile.id, queued: true }
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
      const searchRes = await searchFaceByImage(imageBytes)
      rekognitionRequestId = searchRes.$metadata.requestId
      const top = searchRes.FaceMatches?.[0]
      const topFaceId = top?.Face?.FaceId
      similarityScore = Number(top?.Similarity ?? 0)

      if (!top) {
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
    return {
      status: profile?.status ?? 'REVOKED',
      indexedAt: profile?.indexedAt?.toISOString() ?? null,
      lastVerifiedAt: profile?.lastVerifiedAt?.toISOString() ?? null,
      hasReference: Boolean(profile?.s3KeyReference),
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
    // TODO(prod-launch): require liveness in prod
    return { sessionId: `stub-${userId}-${randomUUID()}`, region: env.AWS_REGION, expiresAtIso: expiresAt.toISOString() }
  },

  async processIndexingJob(payload: { userId: string; faceProfileId: string; s3Key: string }) {
    const profile = await faceVerificationRepository.getProfileByUserId(payload.userId)
    if (!profile || profile.id !== payload.faceProfileId || profile.status !== 'PENDING_INDEX') {
      return
    }
    try {
      const imageBytes = await getImageBytes(payload.s3Key)
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
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') {
        throw new AppError(504, 'Face service timeout', 'face_service_timeout')
      }
      throw error
    }
  },
}

