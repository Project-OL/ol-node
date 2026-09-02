import type { Prisma } from '@prisma/client'
import type { Job } from 'bullmq'
import { randomUUID } from 'crypto'
import { AppError } from '../middlewares/errorHandler'
import { env } from '../config/env'
import { s3Bucket } from '../config/s3'
import { getFaceLivenessSessionResults } from '../lib/rekognition.client'
import { faceRegistrationRepository } from '../repositories/faceRegistration.repository'
import { faceVerificationRepository } from '../repositories/faceVerification.repository'
import { storageService } from '../services/storage.service'
import { runFaceRegistrationAntispoofHooks } from '../services/face-registration/face-registration-antispoof.hooks'
import { faceRegistrationValidationService } from '../services/face-registration/face-registration.validation.service'
import { FACE_REGISTRATION_ERRORS } from '../constants/face-registration-errors'
import { publishServerFrameToUser } from '../utils/ws-publisher'
import type { ServerFrame } from '../realtime/types'
import { FACE_REGISTRATION_VERIFY_JOB } from '../queues/face-registration.constants'
import { rootLogger } from '../utils/rootLogger'
import { RedisKeys, redisClient } from '../config/redis'

const log = rootLogger.child({ module: 'face-registration-verify.job' })

/** Thrown when Rekognition liveness is still IN_PROGRESS — BullMQ should retry with backoff. */
export class FaceLivenessInProgressError extends Error {
  readonly code = 'face_liveness_in_progress'

  constructor() {
    super('face_liveness_in_progress')
    this.name = 'FaceLivenessInProgressError'
  }

  static is(err: unknown): boolean {
    return (
      err instanceof FaceLivenessInProgressError ||
      (err instanceof Error && err.message === 'face_liveness_in_progress')
    )
  }
}

async function emit(
  userId: string,
  event: Extract<ServerFrame, { t: 'FACE_REGISTRATION' }>['event'],
  sessionId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const frame: ServerFrame = { t: 'FACE_REGISTRATION', event, sessionId, detail }
  await publishServerFrameToUser(userId, frame)
}

async function extractReferenceBytes(res: {
  ReferenceImage?: {
    Bytes?: Uint8Array
    S3Object?: { Bucket?: string; Name?: string } | null
  } | null
}): Promise<Uint8Array | null> {
  const ref = res.ReferenceImage
  if (ref?.Bytes && ref.Bytes.byteLength > 0) {
    return ref.Bytes
  }
  const so = ref?.S3Object
  if (so?.Bucket && so.Name && s3Bucket && so.Bucket === s3Bucket.trim()) {
    const buf = await storageService.getObjectBuffer(so.Name)
    return new Uint8Array(buf)
  }
  return null
}

/** Saves a failed/rejected attempt's reference image for admin review, keyed apart
 * from the success path (`face/register/...`) so it's obvious at a glance which
 * images are live profile references vs. rejected capture evidence. */
async function persistFailureImage(userId: string, bytes: Uint8Array): Promise<string | null> {
  try {
    const key = `face/register-failed/${userId}/${randomUUID()}.jpg`
    await storageService.putObjectBuffer({
      key,
      body: Buffer.from(bytes),
      contentType: 'image/jpeg',
      cacheControl: 'private, max-age=0, no-transform',
    })
    return key
  } catch (err) {
    log.warn({ err, userId }, 'face_registration_failure_image_persist_failed')
    return null
  }
}

async function failTerminal(
  sessionId: string,
  userId: string,
  reason: string,
  extra?: {
    rekognitionRawStatus?: string | null
    awsRequestId?: string | null
    status?: 'LIVENESS_FAILED' | 'VALIDATION_FAILED' | 'REJECTED'
    imageBytes?: Uint8Array | null
    audit?: {
      qualityCheckFailures?: string[]
      detectedGender?: string | null
      genderAutoUpdated?: boolean
      duplicateMatchUserId?: string | null
      contentPolicyViolation?: boolean
      details?: Record<string, unknown>
    }
  },
): Promise<void> {
  const status = extra?.status ?? 'LIVENESS_FAILED'
  const failureImageS3Key =
    extra?.imageBytes && extra.imageBytes.byteLength > 0
      ? await persistFailureImage(userId, extra.imageBytes)
      : null
  await faceRegistrationRepository.updateSession(sessionId, {
    status,
    failureReason: reason,
    failureImageS3Key,
    rekognitionRawStatus: extra?.rekognitionRawStatus ?? null,
    awsRequestId: extra?.awsRequestId ?? null,
  })
  await faceRegistrationRepository.appendAudit({
    sessionId,
    userId,
    action: status === 'VALIDATION_FAILED' ? 'validation_failed' : 'liveness_failed',
    details: { reason, ...(extra?.audit?.details ?? {}) },
    qualityCheckFailures: extra?.audit?.qualityCheckFailures,
    detectedGender: extra?.audit?.detectedGender,
    genderAutoUpdated: extra?.audit?.genderAutoUpdated,
    duplicateMatchUserId: extra?.audit?.duplicateMatchUserId,
    contentPolicyViolation: extra?.audit?.contentPolicyViolation,
  })
  const event =
    status === 'REJECTED' ? 'face.registration.rejected' : 'face.registration.liveness_failed'
  await emit(userId, event, sessionId, { reason, ...(extra?.audit?.details ?? {}) })
}

export async function processFaceRegistrationVerifyJob(
  job: Job<{ sessionId: string; userId: string; idempotencyKey: string; requestId?: string }>,
): Promise<void> {
  if (job.name !== FACE_REGISTRATION_VERIFY_JOB) return
  const { sessionId, userId, requestId } = job.data
  const t0 = Date.now()

  const session = await faceRegistrationRepository.findByIdForUser(sessionId, userId)
  if (!session) {
    log.warn({ sessionId, requestId }, 'face_registration_session_missing')
    return
  }
  if (session.expiresAt < new Date()) {
    await faceRegistrationRepository.updateSession(sessionId, { status: 'EXPIRED' })
    await emit(userId, 'face.registration.rejected', sessionId, { reason: 'expired' })
    return
  }
  if (session.status !== 'PROCESSING') {
    log.info({ sessionId, status: session.status, requestId }, 'face_registration_verify_stale')
    return
  }
  if (!session.awsSessionId) {
    await failTerminal(sessionId, userId, 'missing_aws_session')
    return
  }

  if (session.supplementalVideoS3Key?.trim()) {
    try {
      const head = await storageService.headObjectMetadata(session.supplementalVideoS3Key.trim())
      if (head.contentLength <= 0 || head.contentLength > env.FACE_REGISTRATION_VIDEO_MAX_BYTES) {
        await failTerminal(sessionId, userId, 'supplemental_video_size_invalid')
        return
      }
      const ct = (head.contentType ?? '').toLowerCase()
      if (!ct.startsWith('video/')) {
        await failTerminal(sessionId, userId, 'supplemental_video_not_video')
        return
      }
      const replayKey = RedisKeys.faceRegistrationReplayGuard(
        `${userId}:${sessionId}:${head.contentLength}:${head.checksumSha256 ?? 'no-sha256'}`,
      )
      const okReplay = await redisClient.set(replayKey, '1', 'EX', 86400, 'NX')
      if (!okReplay) {
        await failTerminal(sessionId, userId, 'replay_or_duplicate_upload_suspected')
        return
      }
    } catch (e) {
      if (e instanceof AppError && e.code === 'INVALID_MEDIA_OBJECT') {
        await failTerminal(sessionId, userId, 'supplemental_video_missing')
        return
      }
      throw e
    }
  }

  let res
  try {
    res = await getFaceLivenessSessionResults(session.awsSessionId)
  } catch (err) {
    log.error({ err, sessionId, requestId }, 'get_face_liveness_session_results_error')
    throw err
  }

  const rawStatus = res.Status ?? 'UNKNOWN'
  const awsRequestId = res.$metadata.requestId ?? null

  if (rawStatus === 'IN_PROGRESS' || rawStatus === 'CREATED') {
    log.info(
      {
        sessionId,
        rawStatus,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 8,
        requestId,
      },
      'face_liveness_still_in_progress',
    )
    throw new FaceLivenessInProgressError()
  }

  if (rawStatus === 'EXPIRED' || rawStatus === 'FAILED') {
    await failTerminal(sessionId, userId, `rekognition_${rawStatus.toLowerCase()}`, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    })
    return
  }

  if (rawStatus !== 'SUCCEEDED') {
    await failTerminal(sessionId, userId, `rekognition_status_${rawStatus}`, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    })
    return
  }

  const confidence = res.Confidence != null ? Number(res.Confidence) : 0
  const minConf =
    session.riskScore >= env.FACE_REGISTRATION_RISK_SCORE_STRICT
      ? env.FACE_LIVENESS_CONFIDENCE_MIN + env.FACE_LIVENESS_RISK_CONFIDENCE_DELTA
      : env.FACE_LIVENESS_CONFIDENCE_MIN

  // Extracted before the confidence gate: Rekognition returns ReferenceImage
  // regardless of Confidence, and we want it saved even on a confidence-failed attempt.
  const refBytes = await extractReferenceBytes(res)

  if (confidence < minConf) {
    await failTerminal(sessionId, userId, 'liveness_confidence_below_threshold', {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
      imageBytes: refBytes,
    })
    return
  }

  if (!refBytes || refBytes.byteLength < 1024) {
    await failTerminal(sessionId, userId, 'missing_reference_image', {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    })
    return
  }

  const frames: { label: 'reference' | 'audit'; index: number; bytes: Uint8Array }[] = [
    { label: 'reference', index: 0, bytes: refBytes },
  ]
  let idx = 1
  for (const a of res.AuditImages ?? []) {
    if (a.Bytes && a.Bytes.byteLength > 0) {
      frames.push({ label: 'audit', index: idx, bytes: a.Bytes })
      idx += 1
    }
  }

  const antispoof = await runFaceRegistrationAntispoofHooks({
    userId,
    sessionId,
    frames,
  })
  if (!antispoof.ok) {
    await failTerminal(sessionId, userId, `antispoof_${antispoof.reason}`, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
      imageBytes: refBytes,
    })
    return
  }

  const validation = await faceRegistrationValidationService.runFullValidationPipeline(
    refBytes,
    userId,
    { checkMinorAge: true, checkDuplicate: true, livenessPassed: true },
  )

  if (!validation.isValid) {
    const errorCode = validation.errorCode ?? FACE_REGISTRATION_ERRORS.FACE_VALIDATION_FAILED
    const isDuplicate = errorCode === FACE_REGISTRATION_ERRORS.FACE_DUPLICATE_IDENTITY

    if (isDuplicate) {
      const s3KeyRef = `face/register/${userId}/${randomUUID()}.jpg`
      await storageService.putObjectBuffer({
        key: s3KeyRef,
        body: Buffer.from(refBytes),
        contentType: 'image/jpeg',
        cacheControl: 'private, max-age=0, no-transform',
      })
      await faceVerificationRepository.markDuplicate({
        userId,
        collectionId: env.REKOGNITION_COLLECTION_ID,
        s3KeyReference: s3KeyRef,
        qualityScore: validation.qualityScore ?? null,
        duplicateOfUserId: validation.duplicateMatch?.matchedUserId ?? null,
        faceMatchSimilarity: validation.duplicateMatch?.matchSimilarity ?? null,
        moderationLabels: (validation.moderationLabels ?? null) as Prisma.InputJsonValue | null,
        qualityChecksPassed: (validation.qualityChecksPassed ??
          null) as Prisma.InputJsonValue | null,
      })
      await faceRegistrationRepository.updateSession(sessionId, {
        status: 'REJECTED',
        failureReason: errorCode,
        livenessConfidence: confidence,
        rekognitionRawStatus: rawStatus,
        awsRequestId,
        verifiedAt: new Date(),
      })
      await faceRegistrationRepository.appendAudit({
        sessionId,
        userId,
        action: 'duplicate_identity',
        details: {
          duplicateOfUserId: validation.duplicateMatch?.matchedUserId,
          matchedUser: validation.duplicateMatch?.matchedUser,
          matchSimilarity: validation.duplicateMatch?.matchSimilarity,
        },
        latencyMs: Date.now() - t0,
        qualityCheckFailures: validation.details?.failedChecks,
        duplicateMatchUserId: validation.duplicateMatch?.matchedUserId,
      })
      await emit(userId, 'face.registration.rejected', sessionId, {
        reason: errorCode,
        matchedUser: validation.duplicateMatch?.matchedUser,
        matchSimilarity: validation.duplicateMatch?.matchSimilarity,
      })
      return
    }

    await failTerminal(sessionId, userId, errorCode, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
      status: 'VALIDATION_FAILED',
      imageBytes: refBytes,
      audit: {
        qualityCheckFailures: validation.details?.failedChecks,
        contentPolicyViolation: errorCode === FACE_REGISTRATION_ERRORS.FACE_QUALITY_CONTENT_POLICY,
        details: {
          qualityMetrics: validation.details?.qualityMetrics,
          recommendation: validation.details?.recommendation,
        },
      },
    })
    return
  }

  const s3KeyRef = `face/register/${userId}/${randomUUID()}.jpg`
  await storageService.putObjectBuffer({
    key: s3KeyRef,
    body: Buffer.from(refBytes),
    contentType: 'image/jpeg',
    cacheControl: 'private, max-age=0, no-transform',
  })

  await faceVerificationRepository.createPendingProfile({
    userId,
    collectionId: env.REKOGNITION_COLLECTION_ID,
    s3KeyReference: s3KeyRef,
    qualityScore: validation.qualityScore ?? null,
    livenessConfidence: confidence,
    qualityChecksPassed: (validation.qualityChecksPassed ?? null) as Prisma.InputJsonValue | null,
    detectedGender: validation.detectedGender ?? null,
    genderUpdatedAt: validation.genderUpdated ? new Date() : null,
    moderationLabels: (validation.moderationLabels ?? null) as Prisma.InputJsonValue | null,
  })

  await faceRegistrationRepository.updateSession(sessionId, {
    status: 'INDEX_PENDING',
    livenessConfidence: confidence,
    rekognitionRawStatus: rawStatus,
    awsRequestId,
    verifiedAt: new Date(),
    failureReason: null,
  })

  await faceRegistrationRepository.appendAudit({
    sessionId,
    userId,
    action: 'liveness_passed_index_pending',
    details: {
      s3KeyReference: s3KeyRef,
      confidence,
      qualityChecks: validation.qualityChecksPassed,
      genderUpdated: validation.genderUpdated ?? false,
    },
    latencyMs: Date.now() - t0,
    detectedGender: validation.detectedGender,
    genderAutoUpdated: validation.genderUpdated ?? false,
  })

  await emit(userId, 'face.registration.liveness_passed', sessionId, {
    confidence,
    validationStatus: 'PASSED',
    qualityChecks: validation.qualityChecksPassed,
    genderDetected: validation.detectedGender,
    genderUpdated: validation.genderUpdated ?? false,
  })
  await emit(userId, 'face.registration.index_pending', sessionId, { s3KeyReference: s3KeyRef })

  log.info({ userId, sessionId, confidence, requestId }, 'face_registration_liveness_passed')
}

export async function processFaceRegistrationWorkerJob(job: Job): Promise<void> {
  if (job.name === FACE_REGISTRATION_VERIFY_JOB) {
    await processFaceRegistrationVerifyJob(
      job as Job<{ sessionId: string; userId: string; idempotencyKey: string; requestId?: string }>,
    )
  }
}

type FaceRegistrationVerifyJobData = {
  sessionId: string
  userId: string
  idempotencyKey: string
  requestId?: string
}

/**
 * BullMQ `failed` handler — suppress noisy logs for expected liveness polling retries;
 * mark session terminal when the client never completes Face Liveness in time.
 */
export async function onFaceRegistrationVerifyJobFailed(
  job: Job<FaceRegistrationVerifyJobData> | undefined,
  err: Error,
): Promise<void> {
  if (!job || job.name !== FACE_REGISTRATION_VERIFY_JOB) {
    console.error('[face-rekognition-worker] Face registration job failed:', job?.id, err)
    return
  }

  const maxAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 8
  const willRetry = job.attemptsMade < maxAttempts

  if (FaceLivenessInProgressError.is(err)) {
    if (willRetry) {
      log.info(
        {
          sessionId: job.data.sessionId,
          attempt: job.attemptsMade,
          maxAttempts,
          jobId: job.id,
        },
        'face_liveness_in_progress_retry_scheduled',
      )
      return
    }

    const session = await faceRegistrationRepository.findByIdForUser(
      job.data.sessionId,
      job.data.userId,
    )
    if (session?.status === 'PROCESSING') {
      await failTerminal(job.data.sessionId, job.data.userId, 'liveness_not_completed_in_time', {
        rekognitionRawStatus: 'IN_PROGRESS',
      })
    }
    log.warn(
      { sessionId: job.data.sessionId, attemptsMade: job.attemptsMade, jobId: job.id },
      'face_liveness_wait_exhausted',
    )
    return
  }

  console.error('[face-rekognition-worker] Face registration job failed:', job.id, err)

  if (!willRetry) {
    const session = await faceRegistrationRepository.findByIdForUser(
      job.data.sessionId,
      job.data.userId,
    )
    if (session?.status === 'PROCESSING') {
      await failTerminal(job.data.sessionId, job.data.userId, 'worker_error', {
        audit: {
          details: {
            message: err.message?.slice(0, 500),
            name: err.name,
          },
        },
      })
    }
  }
}
