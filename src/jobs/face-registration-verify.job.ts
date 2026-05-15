import type { Job } from "bullmq";
import type { FaceDetail } from "@aws-sdk/client-rekognition";
import { randomUUID } from "crypto";
import { AppError } from "../middlewares/errorHandler";
import { env } from "../config/env";
import { s3Bucket } from "../config/s3";
import {
  detectFacesQuality,
  getFaceLivenessSessionResults,
  searchFaceInCollection,
} from "../lib/rekognition.client";
import { faceRegistrationRepository } from "../repositories/faceRegistration.repository";
import { faceVerificationRepository } from "../repositories/faceVerification.repository";
import { storageService } from "../services/storage.service";
import { runFaceRegistrationAntispoofHooks } from "../services/face-registration/face-registration-antispoof.hooks";
import { publishServerFrameToUser } from "../utils/ws-publisher";
import type { ServerFrame } from "../realtime/types";
import { FACE_REGISTRATION_VERIFY_JOB } from "../queues/face-registration.constants";
import { rootLogger } from "../utils/rootLogger";
import { RedisKeys, redisClient } from "../config/redis";

const log = rootLogger.child({ module: "face-registration-verify.job" });

async function emit(
  userId: string,
  event: Extract<ServerFrame, { t: "FACE_REGISTRATION" }>["event"],
  sessionId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const frame: ServerFrame = { t: "FACE_REGISTRATION", event, sessionId, detail };
  await publishServerFrameToUser(userId, frame);
}

function parseFaceQuality(face: FaceDetail): number {
  const brightness = face.Quality?.Brightness ?? 0;
  const sharpness = face.Quality?.Sharpness ?? 0;
  const confidence = face.Confidence ?? 0;
  if (confidence < env.FACE_MIN_DETECT_CONFIDENCE) {
    throw new AppError(400, "Face confidence too low", "face_quality_rejected");
  }
  if ((face.Sunglasses?.Value ?? false) && (face.Sunglasses?.Confidence ?? 0) > 90) {
    throw new AppError(400, "Sunglasses are not allowed", "face_quality_rejected");
  }
  if (!(face.EyesOpen?.Value ?? true) && (face.EyesOpen?.Confidence ?? 0) > 90) {
    throw new AppError(400, "Eyes must be open", "face_quality_rejected");
  }
  if (brightness < 30 || sharpness < 30) {
    throw new AppError(400, "Image quality too low", "face_quality_rejected");
  }
  return (brightness + sharpness) / 2;
}

async function extractReferenceBytes(res: {
  ReferenceImage?: { Bytes?: Uint8Array; S3Object?: { Bucket?: string; Name?: string } | null } | null;
}): Promise<Uint8Array | null> {
  const ref = res.ReferenceImage;
  if (ref?.Bytes && ref.Bytes.byteLength > 0) {
    return ref.Bytes;
  }
  const so = ref?.S3Object;
  if (so?.Bucket && so.Name && s3Bucket && so.Bucket === s3Bucket.trim()) {
    const buf = await storageService.getObjectBuffer(so.Name);
    return new Uint8Array(buf);
  }
  return null;
}

async function failTerminal(
  sessionId: string,
  userId: string,
  reason: string,
  extra?: { rekognitionRawStatus?: string | null; awsRequestId?: string | null },
): Promise<void> {
  await faceRegistrationRepository.updateSession(sessionId, {
    status: "LIVENESS_FAILED",
    failureReason: reason,
    rekognitionRawStatus: extra?.rekognitionRawStatus ?? null,
    awsRequestId: extra?.awsRequestId ?? null,
  });
  await faceRegistrationRepository.appendAudit({
    sessionId,
    userId,
    action: "liveness_failed",
    details: { reason, ...extra },
  });
  await emit(userId, "face.registration.liveness_failed", sessionId, { reason });
}

export async function processFaceRegistrationVerifyJob(
  job: Job<{ sessionId: string; userId: string; idempotencyKey: string; requestId?: string }>,
): Promise<void> {
  if (job.name !== FACE_REGISTRATION_VERIFY_JOB) return;
  const { sessionId, userId, requestId } = job.data;
  const t0 = Date.now();

  const session = await faceRegistrationRepository.findByIdForUser(sessionId, userId);
  if (!session) {
    log.warn({ sessionId, requestId }, "face_registration_session_missing");
    return;
  }
  if (session.expiresAt < new Date()) {
    await faceRegistrationRepository.updateSession(sessionId, { status: "EXPIRED" });
    await emit(userId, "face.registration.rejected", sessionId, { reason: "expired" });
    return;
  }
  if (session.status !== "PROCESSING") {
    log.info({ sessionId, status: session.status, requestId }, "face_registration_verify_stale");
    return;
  }
  if (!session.awsSessionId) {
    await failTerminal(sessionId, userId, "missing_aws_session");
    return;
  }

  if (session.supplementalVideoS3Key?.trim()) {
    try {
      const head = await storageService.headObjectMetadata(session.supplementalVideoS3Key.trim());
      if (head.contentLength <= 0 || head.contentLength > env.FACE_REGISTRATION_VIDEO_MAX_BYTES) {
        await failTerminal(sessionId, userId, "supplemental_video_size_invalid");
        return;
      }
      const ct = (head.contentType ?? "").toLowerCase();
      if (!ct.startsWith("video/")) {
        await failTerminal(sessionId, userId, "supplemental_video_not_video");
        return;
      }
      const replayKey = RedisKeys.faceRegistrationReplayGuard(
        `${userId}:${sessionId}:${head.contentLength}:${head.checksumSha256 ?? "no-sha256"}`,
      );
      const okReplay = await redisClient.set(replayKey, "1", "EX", 86400, "NX");
      if (!okReplay) {
        await failTerminal(sessionId, userId, "replay_or_duplicate_upload_suspected");
        return;
      }
    } catch (e) {
      if (e instanceof AppError && e.code === "INVALID_MEDIA_OBJECT") {
        await failTerminal(sessionId, userId, "supplemental_video_missing");
        return;
      }
      throw e;
    }
  }

  let res;
  try {
    res = await getFaceLivenessSessionResults(session.awsSessionId);
  } catch (err) {
    log.error({ err, sessionId, requestId }, "get_face_liveness_session_results_error");
    throw err;
  }

  const rawStatus = res.Status ?? "UNKNOWN";
  const awsRequestId = res.$metadata.requestId ?? null;

  if (rawStatus === "IN_PROGRESS" || rawStatus === "CREATED") {
    throw new Error("face_liveness_in_progress");
  }

  if (rawStatus === "EXPIRED" || rawStatus === "FAILED") {
    await failTerminal(sessionId, userId, `rekognition_${rawStatus.toLowerCase()}`, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    });
    return;
  }

  if (rawStatus !== "SUCCEEDED") {
    await failTerminal(sessionId, userId, `rekognition_status_${rawStatus}`, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    });
    return;
  }

  const confidence = res.Confidence != null ? Number(res.Confidence) : 0;
  const minConf =
    session.riskScore >= env.FACE_REGISTRATION_RISK_SCORE_STRICT
      ? env.FACE_LIVENESS_CONFIDENCE_MIN + env.FACE_LIVENESS_RISK_CONFIDENCE_DELTA
      : env.FACE_LIVENESS_CONFIDENCE_MIN;
  if (confidence < minConf) {
    await failTerminal(sessionId, userId, "liveness_confidence_below_threshold", {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    });
    return;
  }

  const refBytes = await extractReferenceBytes(res);
  if (!refBytes || refBytes.byteLength < 1024) {
    await failTerminal(sessionId, userId, "missing_reference_image", {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    });
    return;
  }

  const frames: { label: "reference" | "audit"; index: number; bytes: Uint8Array }[] = [
    { label: "reference", index: 0, bytes: refBytes },
  ];
  let idx = 1;
  for (const a of res.AuditImages ?? []) {
    if (a.Bytes && a.Bytes.byteLength > 0) {
      frames.push({ label: "audit", index: idx, bytes: a.Bytes });
      idx += 1;
    }
  }

  const antispoof = await runFaceRegistrationAntispoofHooks({
    userId,
    sessionId,
    frames,
  });
  if (!antispoof.ok) {
    await failTerminal(sessionId, userId, `antispoof_${antispoof.reason}`, {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    });
    return;
  }

  let detect;
  try {
    detect = await detectFacesQuality(refBytes);
  } catch (err) {
    log.error({ err, sessionId, requestId }, "detect_faces_after_liveness_failed");
    throw err;
  }
  const faces = detect.FaceDetails ?? [];
  if (faces.length !== 1) {
    await failTerminal(sessionId, userId, faces.length === 0 ? "no_face_in_reference" : "multiple_faces_in_reference", {
      rekognitionRawStatus: rawStatus,
      awsRequestId,
    });
    return;
  }

  let qualityScore: number;
  try {
    qualityScore = parseFaceQuality(faces[0]!);
  } catch (e) {
    const code = e instanceof AppError ? e.code : "face_quality_rejected";
    await failTerminal(sessionId, userId, String(code), { rekognitionRawStatus: rawStatus, awsRequestId });
    return;
  }

  let dup;
  try {
    dup = await searchFaceInCollection({
      imageBytes: refBytes,
      collectionId: env.REKOGNITION_COLLECTION_ID,
      threshold: Number(env.FACE_MATCH_THRESHOLD_PASS),
    });
  } catch (err) {
    log.error({ err, sessionId, requestId }, "duplicate_search_failed");
    throw err;
  }

  if (dup) {
    const ownerProfile = await faceVerificationRepository.findProfileByRekognitionFaceId(dup.faceId);
    const duplicateOfUserId = ownerProfile?.userId ?? null;
    if (!duplicateOfUserId || duplicateOfUserId !== userId) {
      const s3KeyRef = `face/register/${userId}/${randomUUID()}.jpg`;
      await storageService.putObjectBuffer({
        key: s3KeyRef,
        body: Buffer.from(refBytes),
        contentType: "image/jpeg",
        cacheControl: "private, max-age=0, no-transform",
      });
      await faceVerificationRepository.markDuplicate({
        userId,
        collectionId: env.REKOGNITION_COLLECTION_ID,
        s3KeyReference: s3KeyRef,
        qualityScore,
        duplicateOfUserId,
      });
      await faceRegistrationRepository.updateSession(sessionId, {
        status: "REJECTED",
        failureReason: "FACE_DUPLICATE_IDENTITY",
        livenessConfidence: confidence,
        rekognitionRawStatus: rawStatus,
        awsRequestId,
        verifiedAt: new Date(),
      });
      await faceRegistrationRepository.appendAudit({
        sessionId,
        userId,
        action: "duplicate_identity",
        details: { duplicateOfUserId },
        latencyMs: Date.now() - t0,
      });
      await emit(userId, "face.registration.rejected", sessionId, { reason: "FACE_DUPLICATE_IDENTITY" });
      return;
    }
  }

  const s3KeyRef = `face/register/${userId}/${randomUUID()}.jpg`;
  await storageService.putObjectBuffer({
    key: s3KeyRef,
    body: Buffer.from(refBytes),
    contentType: "image/jpeg",
    cacheControl: "private, max-age=0, no-transform",
  });

  await faceVerificationRepository.createPendingProfile({
    userId,
    collectionId: env.REKOGNITION_COLLECTION_ID,
    s3KeyReference: s3KeyRef,
    qualityScore,
    livenessConfidence: confidence,
  });

  await faceRegistrationRepository.updateSession(sessionId, {
    status: "INDEX_PENDING",
    livenessConfidence: confidence,
    rekognitionRawStatus: rawStatus,
    awsRequestId,
    verifiedAt: new Date(),
    failureReason: null,
  });

  await faceRegistrationRepository.appendAudit({
    sessionId,
    userId,
    action: "liveness_passed_index_pending",
    details: { s3KeyReference: s3KeyRef, confidence },
    latencyMs: Date.now() - t0,
  });

  await emit(userId, "face.registration.liveness_passed", sessionId, { confidence });
  await emit(userId, "face.registration.index_pending", sessionId, { s3KeyReference: s3KeyRef });

  log.info({ userId, sessionId, confidence, requestId }, "face_registration_liveness_passed");
}

export async function processFaceRegistrationWorkerJob(job: Job): Promise<void> {
  if (job.name === FACE_REGISTRATION_VERIFY_JOB) {
    await processFaceRegistrationVerifyJob(
      job as Job<{ sessionId: string; userId: string; idempotencyKey: string; requestId?: string }>,
    );
  }
}
