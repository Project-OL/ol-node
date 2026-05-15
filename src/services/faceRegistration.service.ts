import { randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { AppError } from "../middlewares/errorHandler";
import { env } from "../config/env";
import { prisma } from "../config/database";
import { s3Bucket } from "../config/s3";
import { redisClient, RedisKeys } from "../config/redis";
import { storageService } from "./storage.service";
import { faceRegistrationRepository } from "../repositories/faceRegistration.repository";
import { faceVerificationRepository } from "../repositories/faceVerification.repository";
import { createFaceLivenessSession, ensureCollectionExists } from "../lib/rekognition.client";
import { buildRandomChallengeSequence } from "./face-registration/face-registration.challenges";
import { computeFaceRegistrationRiskScore } from "./face-registration/face-registration.risk";
import { enqueueFaceRegistrationVerification } from "../queues/face-registration.queue";
import { publishServerFrameToUser } from "../utils/ws-publisher";
import type { ServerFrame } from "../realtime/types";
import { rootLogger } from "../utils/rootLogger";

const log = rootLogger.child({ module: "faceRegistration.service" });

type RequestCtx = { ip?: string; headers?: Record<string, string | string[] | undefined> };

function toHeaderString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function extractIp(ctx: RequestCtx): string | undefined {
  const xff = toHeaderString(ctx.headers?.["x-forwarded-for"]);
  if (xff) return xff.split(",")[0]?.trim();
  return ctx.ip;
}

async function emitFaceRegistration(
  userId: string,
  event: Extract<ServerFrame, { t: "FACE_REGISTRATION" }>["event"],
  sessionId: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  const frame: ServerFrame = { t: "FACE_REGISTRATION", event, sessionId, detail };
  await publishServerFrameToUser(userId, frame);
}

function validateSessionVideoKey(userId: string, sessionId: string, s3Key: string): void {
  const prefix = `face-registration/temp/${userId}/${sessionId}/`;
  if (!s3Key.startsWith(prefix)) {
    throw new AppError(400, "Invalid supplemental video key", "FACE_REG_INVALID_VIDEO_KEY");
  }
  if (s3Key.includes("..") || s3Key.includes("\0") || s3Key.includes("//")) {
    throw new AppError(400, "Invalid supplemental video key", "FACE_REG_INVALID_VIDEO_KEY");
  }
}

export const faceRegistrationService = {
  /**
   * After `worker-face-index` marks profile INDEXED, close out any `INDEX_PENDING` registration session.
   */
  async onFaceProfileIndexed(userId: string): Promise<void> {
    const sid = await faceRegistrationRepository.markLatestIndexPendingAsIndexed(userId);
    if (sid) {
      await emitFaceRegistration(userId, "face.registration.indexed", sid, {
        faceProfileIndexed: true,
      });
    }
  },

  async createSession(
    userId: string,
    ctx: RequestCtx,
    body?: { deviceMetadata?: Record<string, unknown> },
  ) {
    const existing = await faceVerificationRepository.getProfileByUserId(userId);
    if (existing?.status === "INDEXED") {
      throw new AppError(409, "Face profile already indexed", "FACE_REG_ALREADY_INDEXED");
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [sessionsLast24h, failedLast24h] = await Promise.all([
      prisma.faceRegistrationSession.count({
        where: { userId, createdAt: { gte: since } },
      }),
      prisma.faceRegistrationSession.count({
        where: {
          userId,
          status: "LIVENESS_FAILED",
          createdAt: { gte: since },
        },
      }),
    ]);

    const riskScore = computeFaceRegistrationRiskScore({
      sessionsLast24h,
      failedLivenessLast24h: failedLast24h,
      supplementalVideoProvided: !env.FACE_REGISTRATION_SUPPLEMENTAL_VIDEO_REQUIRED,
    });

    const challengeSequence = buildRandomChallengeSequence();
    const challengeNonce = randomUUID().replace(/-/g, "").slice(0, 32);
    const uploadNonce = randomUUID();
    const clientRequestToken = randomUUID();
    const expiresAt = new Date(Date.now() + env.FACE_REGISTRATION_SESSION_TTL_MIN * 60 * 1000);

    await ensureCollectionExists();

    const bucket = s3Bucket?.trim();
    const aws = await createFaceLivenessSession({
      clientRequestToken,
      auditImagesLimit: env.FACE_LIVENESS_AUDIT_IMAGES_LIMIT,
      outputBucket: bucket,
      outputPrefix: `${env.FACE_LIVENESS_S3_OUTPUT_PREFIX}/${userId}/`,
    });
    const awsSessionId = aws.SessionId;
    if (!awsSessionId) {
      throw new AppError(502, "Face liveness session could not be created", "FACE_REG_LIVENESS_CREATE_FAILED");
    }

    const session = await prisma.$transaction(async (tx) => {
      await faceRegistrationRepository.expireOpenSessionsForUser(userId, tx);
      return faceRegistrationRepository.createSession(
        {
          userId,
          awsSessionId,
          challengeSequence: challengeSequence as unknown as Prisma.InputJsonValue,
          challengeNonce,
          uploadNonce,
          riskScore,
          deviceMetadata: (body?.deviceMetadata ?? null) as Prisma.InputJsonValue | null,
          ipAddress: extractIp(ctx) ?? null,
          expiresAt,
        },
        tx,
      );
    });

    await faceRegistrationRepository.appendAudit({
      sessionId: session.id,
      userId,
      action: "session_created",
      details: { awsSessionId, riskScore },
      ipAddress: extractIp(ctx) ?? null,
      userAgent: toHeaderString(ctx.headers?.["user-agent"]),
    });

    log.info({ userId, sessionId: session.id, awsSessionId }, "face_registration_session_created");

    return {
      sessionId: session.id,
      rekognitionSessionId: awsSessionId,
      region: env.AWS_REGION,
      expiresAt: session.expiresAt.toISOString(),
      status: session.status,
      challengePayload: {
        nonce: challengeNonce,
        steps: challengeSequence,
        hint: "Complete Face Liveness in the mobile SDK using rekognitionSessionId; server polls results asynchronously.",
      },
      uploadUrls: null as null,
      retryCount: 0,
      riskScore,
      deviceMetadata: body?.deviceMetadata ?? null,
      ipAddress: extractIp(ctx) ?? null,
    };
  },

  async createUploadUrl(
    userId: string,
    sessionId: string,
    mimeType: "video/mp4" | "video/quicktime",
    ctx: RequestCtx,
  ) {
    const bucket = s3Bucket?.trim();
    if (!bucket) {
      throw new AppError(503, "File storage is not configured", "S3_NOT_CONFIGURED");
    }
    const session = await faceRegistrationRepository.findByIdForUser(sessionId, userId);
    if (!session || session.expiresAt < new Date()) {
      throw new AppError(404, "Registration session not found or expired", "FACE_REG_SESSION_NOT_FOUND");
    }
    if (session.status !== "PENDING" && session.status !== "UPLOADED") {
      throw new AppError(409, "Session is not accepting uploads", "FACE_REG_SESSION_INVALID_STATE");
    }

    const ext = mimeType === "video/mp4" ? "mp4" : "mov";
    const s3Key = `face-registration/temp/${userId}/${sessionId}/raw.${ext}`;
    validateSessionVideoKey(userId, sessionId, s3Key);

    const expiresInSec = 900;
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, mimeType, expiresInSec, {
      cacheControl: "private, max-age=0, no-transform",
    });

    await faceRegistrationRepository.updateSession(sessionId, {
      supplementalVideoS3Key: s3Key,
      status: "UPLOADED",
    });

    await faceRegistrationRepository.appendAudit({
      sessionId,
      userId,
      action: "supplemental_upload_url_issued",
      details: { s3Key, mimeType },
      ipAddress: extractIp(ctx) ?? null,
      userAgent: toHeaderString(ctx.headers?.["user-agent"]),
    });

    return {
      uploadUrl,
      s3Key,
      publicUrl: storageService.getCdnOrS3PublicUrl(s3Key),
      expiresInSec,
      uploadNonce: session.uploadNonce,
    };
  },

  async requestVerify(
    userId: string,
    sessionId: string,
    idempotencyKey: string,
    ctx: RequestCtx,
    requestId?: string,
  ): Promise<{ status: "PROCESSING" }> {
    const session = await faceRegistrationRepository.findByIdForUser(sessionId, userId);
    if (!session || session.expiresAt < new Date()) {
      throw new AppError(404, "Registration session not found or expired", "FACE_REG_SESSION_NOT_FOUND");
    }

    if (env.FACE_REGISTRATION_SUPPLEMENTAL_VIDEO_REQUIRED) {
      if (!session.supplementalVideoS3Key?.trim()) {
        throw new AppError(400, "Supplemental video upload is required before verify", "FACE_REG_VIDEO_REQUIRED");
      }
    }

    const lockKey = RedisKeys.faceRegistrationLock(userId);
    const locked = await redisClient.set(lockKey, sessionId, "EX", 120, "NX");
    if (!locked) {
      throw new AppError(409, "Another face registration operation is in progress", "FACE_REG_LOCK_BUSY");
    }

    try {
      const idemKey = RedisKeys.faceRegistrationVerifyIdem(sessionId, idempotencyKey);
      const first = await redisClient.set(idemKey, "1", "EX", 86400, "NX");
      if (!first) {
        return { status: "PROCESSING" };
      }

      if (session.status === "INDEX_PENDING" || session.status === "INDEXED") {
        return { status: "PROCESSING" };
      }

      if (session.status !== "PENDING" && session.status !== "UPLOADED") {
        throw new AppError(409, "Session cannot be verified from this state", "FACE_REG_SESSION_INVALID_STATE", {
          state: session.status,
        });
      }

      await faceRegistrationRepository.updateSession(sessionId, {
        status: "PROCESSING",
        idempotencyKey,
      });
      await faceRegistrationRepository.appendAudit({
        sessionId,
        userId,
        action: "verify_enqueued",
        details: { idempotencyKey },
        ipAddress: extractIp(ctx) ?? null,
        userAgent: toHeaderString(ctx.headers?.["user-agent"]),
      });
      await emitFaceRegistration(userId, "face.registration.processing", sessionId, { idempotencyKey });
      await enqueueFaceRegistrationVerification({
        sessionId,
        userId,
        idempotencyKey,
        requestId,
      });
      return { status: "PROCESSING" };
    } finally {
      await redisClient.del(lockKey);
    }
  },
};
