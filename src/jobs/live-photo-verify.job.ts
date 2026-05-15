import type { Job } from "bullmq";
import { Prisma } from "@prisma/client";
import { env } from "../config/env";
import {
  compareFacesIndexedToLive,
  detectFacesQuality,
  isRekognitionInvalidImageFormatError,
} from "../lib/rekognition.client";
import { RedisKeys, redisClient } from "../config/redis";
import { livePhotoRepository } from "../repositories/livePhoto.repository";
import { faceVerificationRepository } from "../repositories/faceVerification.repository";
import { storageService } from "../services/storage.service";
import { bustLivePhotoCaches } from "../services/live-photo/live-photo-cache";
import { livePhotoPreCompareHooks } from "../services/live-photo/live-photo-extension.hooks";
import { livePhotoMetrics } from "../services/live-photo/live-photo.metrics";
import {
  LIVE_PHOTO_S3_PURGE_JOB,
  LIVE_PHOTO_VERIFY_JOB,
} from "../queues/live-photo.constants";
import { rootLogger } from "../utils/rootLogger";

const log = rootLogger.child({ module: "live-photo-verify.job" });

function parseTargetFaceQuality(
  face: NonNullable<Awaited<ReturnType<typeof detectFacesQuality>>["FaceDetails"]>[number],
): { ok: true } | { ok: false; reason: string } {
  const confidence = face.Confidence ?? 0;
  if (confidence < env.FACE_MIN_DETECT_CONFIDENCE) {
    return { ok: false, reason: "face_confidence_low" };
  }
  if ((face.Sunglasses?.Value ?? false) && (face.Sunglasses?.Confidence ?? 0) > 90) {
    return { ok: false, reason: "sunglasses_not_allowed" };
  }
  if (!(face.EyesOpen?.Value ?? true) && (face.EyesOpen?.Confidence ?? 0) > 90) {
    return { ok: false, reason: "eyes_must_be_open" };
  }
  const brightness = face.Quality?.Brightness ?? 0;
  const sharpness = face.Quality?.Sharpness ?? 0;
  if (brightness < 30 || sharpness < 30) {
    return { ok: false, reason: "image_quality_low" };
  }
  const bb = face.BoundingBox;
  if (bb?.Width != null && bb?.Height != null) {
    const area = bb.Width * bb.Height;
    if (area < env.LIVE_PHOTO_MIN_FACE_AREA) {
      return { ok: false, reason: "face_too_small" };
    }
  }
  return { ok: true };
}

export async function processLivePhotoVerifyJob(
  job: Job<{ userId: string; s3Key: string; generation: number; requestId?: string }>,
): Promise<void> {
  if (job.name !== LIVE_PHOTO_VERIFY_JOB) return;
  const { userId, s3Key, generation, requestId } = job.data;
  const t0 = Date.now();
  const lockKey = RedisKeys.livePhotoVerifyLock(userId);
  const lockOk = await redisClient.set(lockKey, "1", "EX", env.LIVE_PHOTO_VERIFY_LOCK_TTL_SEC, "NX");
  if (!lockOk) {
    log.warn({ userId, generation, requestId }, "live_photo_verify_lock_contended");
    livePhotoMetrics.verifyStaleSkipped += 1;
    return;
  }
  try {
    const row = await livePhotoRepository.findByUserId(userId);
    if (!row || row.verifyGeneration !== generation || row.verificationState !== "PROCESSING") {
      log.info({ userId, generation, requestId }, "live_photo_verify_stale_job");
      livePhotoMetrics.verifyStaleSkipped += 1;
      return;
    }
    if (row.s3Key !== s3Key) {
      log.warn(
        { userId, generation, requestId, jobS3Key: s3Key, rowS3Key: row.s3Key },
        "live_photo_verify_job_s3_key_mismatch_superseded",
      );
      livePhotoMetrics.verifyStaleSkipped += 1;
      return;
    }

    const face = await faceVerificationRepository.getProfileByUserId(userId);
    if (!face || face.status !== "INDEXED" || !face.s3KeyReference?.trim()) {
      await failAndAudit(userId, row.id, "face_profile_not_indexed", null, t0, null);
      return;
    }

    let head;
    try {
      head = await storageService.headObjectMetadata(s3Key);
    } catch {
      await failAndAudit(userId, row.id, "live_object_missing", null, t0, null);
      return;
    }

    for (const hook of livePhotoPreCompareHooks) {
      const r = await hook({
        userId,
        livePhotoS3Key: s3Key,
        sourceFaceS3Key: face.s3KeyReference,
        requestId,
        targetContentLength: head.contentLength,
        targetContentType: head.contentType,
      });
      if (!r.pass) {
        await failAndAudit(userId, row.id, r.reason, null, t0, null, null, { hook: true });
        return;
      }
    }

    const [sourceBytes, targetBytes] = await Promise.all([
      storageService.getObjectBuffer(face.s3KeyReference),
      storageService.getObjectBuffer(s3Key),
    ]);

    const detectT0 = Date.now();
    let detectRes;
    try {
      detectRes = await detectFacesQuality(targetBytes);
    } catch (err) {
      if (isRekognitionInvalidImageFormatError(err)) {
        log.warn(
          {
            err,
            userId,
            requestId,
            s3Key,
            contentLength: head.contentLength,
            contentType: head.contentType,
          },
          "live_photo_rekognition_invalid_live_image_format",
        );
        await failAndAudit(userId, row.id, "invalid_image_format", null, t0, null);
        return;
      }
      log.error({ err, userId, requestId, s3Key }, "live_photo_detect_faces_error");
      await failAndAudit(userId, row.id, "rekognition_detect_error", null, t0, null);
      return;
    }
    const detectMs = Date.now() - detectT0;
    const faces = detectRes.FaceDetails ?? [];
    if (faces.length === 0) {
      await failAndAudit(userId, row.id, "no_face_in_live_image", null, t0, null);
      return;
    }
    if (faces.length > 1) {
      await failAndAudit(userId, row.id, "multiple_faces_in_live_image", null, t0, null);
      return;
    }
    const q = parseTargetFaceQuality(faces[0]!);
    if (!q.ok) {
      await failAndAudit(userId, row.id, q.reason, null, t0, null);
      return;
    }

    const cmpT0 = Date.now();
    let cmp;
    try {
      cmp = await compareFacesIndexedToLive({
        sourceImageBytes: sourceBytes,
        targetImageBytes: targetBytes,
        similarityThreshold: env.LIVE_PHOTO_MATCH_THRESHOLD,
      });
    } catch (err) {
      if (isRekognitionInvalidImageFormatError(err)) {
        log.warn(
          {
            err,
            userId,
            requestId,
            liveS3Key: s3Key,
            referenceS3Key: face.s3KeyReference,
          },
          "live_photo_rekognition_invalid_image_format_compare",
        );
        await failAndAudit(userId, row.id, "invalid_image_format", null, t0, Date.now() - cmpT0);
        return;
      }
      log.error({ err, userId, requestId }, "compare_faces_error");
      await failAndAudit(userId, row.id, "rekognition_compare_error", null, t0, Date.now() - cmpT0);
      return;
    }
    const rekMs = Date.now() - cmpT0;
    livePhotoMetrics.rekognitionCompareMsTotal += rekMs;
    livePhotoMetrics.rekognitionCompareSamples += 1;

    const top = cmp.FaceMatches?.[0];
    const similarity = top?.Similarity != null ? Number(top.Similarity) : 0;
    const requestIdRek = cmp.$metadata.requestId ?? null;

    if (!top || similarity < env.LIVE_PHOTO_MATCH_THRESHOLD) {
      await failAndAudit(
        userId,
        row.id,
        "below_similarity_threshold",
        requestIdRek,
        t0,
        rekMs,
        similarity,
      );
      return;
    }

    const imageUrl = storageService.getCdnOrS3PublicUrl(s3Key);
    await livePhotoRepository.markVerified(userId, {
      imageUrl,
      similarityScore: similarity,
      faceProfileId: face.id,
    });
    await livePhotoRepository.createAttempt({
      userId,
      livePhotoId: row.id,
      similarityScore: similarity,
      matched: true,
      rekognitionRequestId: requestIdRek,
      failureReason: null,
      processingLatencyMs: Date.now() - t0,
      rekognitionLatencyMs: rekMs,
      metadata: { detectFacesMs: detectMs },
    });
    livePhotoMetrics.verifyJobsCompleted += 1;
    log.info(
      {
        userId,
        generation,
        similarity,
        rekognitionMs: rekMs,
        totalMs: Date.now() - t0,
        requestId,
      },
      "live_photo_verified",
    );
    await bustLivePhotoCaches(userId);
  } finally {
    await redisClient.del(lockKey).catch(() => undefined);
  }
}

async function failAndAudit(
  userId: string,
  livePhotoId: string,
  reason: string,
  rekognitionRequestId: string | null,
  t0: number,
  rekognitionLatencyMs: number | null,
  similarityScore: number | null = null,
  metadata?: Prisma.InputJsonValue,
): Promise<void> {
  await livePhotoRepository.markFailed(userId, reason);
  try {
    await recordAttemptEnd({
      userId,
      livePhotoId,
      matched: false,
      similarityScore,
      rekognitionRequestId,
      failureReason: reason,
      processingLatencyMs: Date.now() - t0,
      rekognitionLatencyMs,
      metadata,
    });
  } catch (err) {
    log.error({ err, userId, livePhotoId, reason }, "live_photo_record_attempt_failed");
  } finally {
    livePhotoMetrics.verifyJobsFailed += 1;
    await bustLivePhotoCaches(userId);
  }
}

async function recordAttemptEnd(input: {
  userId: string;
  livePhotoId: string;
  matched: boolean;
  similarityScore: number | null;
  rekognitionRequestId: string | null;
  failureReason: string | null;
  processingLatencyMs: number;
  rekognitionLatencyMs: number | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  await livePhotoRepository.createAttempt({
    userId: input.userId,
    livePhotoId: input.livePhotoId,
    similarityScore: input.similarityScore,
    matched: input.matched,
    rekognitionRequestId: input.rekognitionRequestId,
    failureReason: input.failureReason,
    processingLatencyMs: input.processingLatencyMs,
    rekognitionLatencyMs: input.rekognitionLatencyMs,
    metadata: input.metadata,
  });
}

export async function processLivePhotoS3PurgeJob(job: Job<{ keys: string[] }>): Promise<void> {
  if (job.name !== LIVE_PHOTO_S3_PURGE_JOB) return;
  const keys = job.data?.keys ?? [];
  for (const key of keys) {
    if (!key || key.includes("..")) continue;
    try {
      await storageService.deleteObject(key);
      livePhotoMetrics.purgeJobsCompleted += 1;
    } catch (err) {
      livePhotoMetrics.purgeJobsFailed += 1;
      log.warn({ err, key }, "live_photo_s3_purge_failed");
    }
  }
}

export async function processLivePhotoWorkerJob(job: Job): Promise<void> {
  if (job.name === LIVE_PHOTO_VERIFY_JOB) {
    await processLivePhotoVerifyJob(job as Job<{ userId: string; s3Key: string; generation: number }>);
  } else if (job.name === LIVE_PHOTO_S3_PURGE_JOB) {
    await processLivePhotoS3PurgeJob(job as Job<{ keys: string[] }>);
  }
}
