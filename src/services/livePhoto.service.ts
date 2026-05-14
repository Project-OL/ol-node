import { randomUUID } from "crypto";
import { LivePhotoVerificationState } from "@prisma/client";
import { env } from "../config/env";
import { s3Bucket } from "../config/s3";
import { RedisKeys, redisClient } from "../config/redis";
import { AppError } from "../middlewares/errorHandler";
import { cacheRedisService } from "./cacheRedis.service";
import { storageService } from "./storage.service";
import { faceVerificationRepository } from "../repositories/faceVerification.repository";
import { livePhotoRepository } from "../repositories/livePhoto.repository";
import {
  enqueueLivePhotoS3Purge,
  enqueueLivePhotoVerification,
} from "../queues/live-photo.queue";
import { rootLogger } from "../utils/rootLogger";
import { bustLivePhotoCaches } from "./live-photo/live-photo-cache";

const log = rootLogger.child({ module: "livePhoto.service" });

const ALLOWED_LIVE_MIME = new Map<string, string>([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export type LivePhotoMeStatusDto = {
  hasLivePhoto: boolean;
  verificationState: LivePhotoVerificationState;
  verifiedAt: string | null;
  imageUrl: string | null;
  similarityScore: number | null;
};

function validateOwnedLivePhotoKey(userId: string, s3Key: string): void {
  const prefix = `live-photo/${userId}/`;
  if (!s3Key.startsWith(prefix)) {
    throw new AppError(400, "Invalid live photo key for user", "LIVE_PHOTO_INVALID_KEY");
  }
  if (s3Key.includes("..") || s3Key.includes("\0") || s3Key.includes("//")) {
    throw new AppError(400, "Invalid live photo key", "LIVE_PHOTO_INVALID_KEY");
  }
}

function buildS3Key(userId: string, ext: string): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `live-photo/${userId}/${y}/${m}/${randomUUID()}.${ext}`;
}

function rowToMeDto(row: Awaited<ReturnType<typeof livePhotoRepository.findByUserId>>): LivePhotoMeStatusDto {
  if (!row) {
    return {
      hasLivePhoto: false,
      verificationState: LivePhotoVerificationState.NOT_UPLOADED,
      verifiedAt: null,
      imageUrl: null,
      similarityScore: null,
    };
  }
  const hasKey = row.s3Key.trim().length > 0;
  const hasLivePhoto =
    hasKey ||
    row.verificationState === "VERIFIED" ||
    row.verificationState === "PROCESSING" ||
    row.verificationState === "PENDING_VERIFICATION";
  let imageUrl: string | null = null;
  if (row.verificationState === "VERIFIED") {
    imageUrl =
      row.imageUrl?.trim() ||
      (hasKey ? safePublicUrl(row.s3Key) : null);
  }
  return {
    hasLivePhoto,
    verificationState: row.verificationState,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    imageUrl,
    similarityScore:
      row.verificationState === "VERIFIED" && row.similarityScore != null
        ? Math.round(row.similarityScore * 100) / 100
        : null,
  };
}

function safePublicUrl(key: string): string | null {
  try {
    return storageService.getCdnOrS3PublicUrl(key);
  } catch {
    return null;
  }
}

export const livePhotoService = {
  async getMeStatus(userId: string): Promise<LivePhotoMeStatusDto> {
    const cacheKey = RedisKeys.livePhotoProfile(userId);
    const cached = await cacheRedisService.get<LivePhotoMeStatusDto>(cacheKey);
    if (cached) return cached;
    const row = await livePhotoRepository.findByUserId(userId);
    const dto = rowToMeDto(row);
    await cacheRedisService.set(cacheKey, dto, env.LIVE_PHOTO_PROFILE_CACHE_TTL_SEC);
    return dto;
  },

  /** Compact block for GET /users/me (no Redis — follows wallet/guardian always-fresh pattern). */
  async buildMeLivePhotoBlock(userId: string): Promise<{
    verified: boolean;
    imageUrl: string | null;
    verifiedAt: string | null;
  }> {
    const row = await livePhotoRepository.findByUserId(userId);
    if (!row || row.verificationState !== "VERIFIED") {
      return { verified: false, imageUrl: null, verifiedAt: null };
    }
    const imageUrl =
      row.imageUrl?.trim() ||
      (row.s3Key ? safePublicUrl(row.s3Key) : null);
    return {
      verified: true,
      imageUrl,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
    };
  },

  async createUploadUrl(userId: string, mimeType: string): Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
    expiresInSec: number;
  }> {
    const bucket = s3Bucket?.trim();
    if (!bucket) {
      throw new AppError(503, "File storage is not configured", "S3_NOT_CONFIGURED");
    }
    const normalized = mimeType.trim().toLowerCase();
    const ext = ALLOWED_LIVE_MIME.get(normalized);
    if (!ext) {
      throw new AppError(400, "Only JPEG, PNG, or WEBP images are allowed", "LIVE_PHOTO_INVALID_MIME");
    }
    const s3Key = buildS3Key(userId, ext);
    const expiresInSec = env.LIVE_PHOTO_UPLOAD_URL_EXPIRES_SEC;
    const uploadUrl = await storageService.getPresignedPutUrl(s3Key, normalized, expiresInSec, {
      cacheControl: "private, max-age=0, no-transform",
    });
    await livePhotoRepository.upsertPendingUpload(userId, {
      s3Key,
      s3Bucket: bucket,
      verificationState: "PENDING_UPLOAD",
    });
    const publicUrl = storageService.getCdnOrS3PublicUrl(s3Key);
    await bustLivePhotoCaches(userId);
    await redisClient.set(
      RedisKeys.livePhotoVerifyStatus(userId),
      JSON.stringify({ state: "PENDING_UPLOAD", at: Date.now() }),
      "EX",
      env.LIVE_PHOTO_VERIFY_STATUS_CACHE_TTL_SEC,
    );
    return { uploadUrl, s3Key, publicUrl, expiresInSec };
  },

  async requestVerify(userId: string, s3Key: string, requestId?: string): Promise<
    | { status: "PROCESSING" }
    | { status: "VERIFIED"; verifiedAt: string; imageUrl: string | null; similarityScore: number }
  > {
    validateOwnedLivePhotoKey(userId, s3Key);
    const bucket = s3Bucket?.trim();
    if (!bucket) {
      throw new AppError(503, "File storage is not configured", "S3_NOT_CONFIGURED");
    }

    const face = await faceVerificationRepository.getProfileByUserId(userId);
    if (!face || face.status !== "INDEXED" || !face.s3KeyReference?.trim()) {
      throw new AppError(
        400,
        "Face profile must be indexed before live photo verification",
        "LIVE_PHOTO_FACE_NOT_READY",
      );
    }

    const row = await livePhotoRepository.findByUserId(userId);
    if (!row || row.s3Key !== s3Key) {
      throw new AppError(400, "Live photo key does not match pending upload", "LIVE_PHOTO_KEY_MISMATCH");
    }

    if (row.verificationState === "VERIFIED" && row.s3Key === s3Key) {
      return {
        status: "VERIFIED",
        verifiedAt: row.verifiedAt!.toISOString(),
        imageUrl: row.imageUrl ?? safePublicUrl(row.s3Key),
        similarityScore: row.similarityScore ?? 0,
      };
    }

    if (row.verificationState === "PROCESSING" && row.s3Key === s3Key) {
      await redisClient.set(
        RedisKeys.livePhotoVerifyStatus(userId),
        JSON.stringify({ state: "PROCESSING", at: Date.now() }),
        "EX",
        env.LIVE_PHOTO_VERIFY_STATUS_CACHE_TTL_SEC,
      );
      return { status: "PROCESSING" };
    }

    if (row.verificationState !== "PENDING_UPLOAD") {
      throw new AppError(
        409,
        "Live photo is not awaiting verification",
        "LIVE_PHOTO_INVALID_STATE",
        { state: row.verificationState },
      );
    }

    let meta;
    try {
      meta = await storageService.headObjectMetadata(s3Key);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw e;
    }
    if (meta.contentLength <= 0 || meta.contentLength > env.LIVE_PHOTO_MAX_SIZE_BYTES) {
      throw new AppError(413, "Live photo file size is invalid", "LIVE_PHOTO_FILE_TOO_LARGE", {
        maxBytes: env.LIVE_PHOTO_MAX_SIZE_BYTES,
      });
    }
    const ct = (meta.contentType ?? "").toLowerCase();
    if (ct && !ct.startsWith("image/")) {
      throw new AppError(400, "Uploaded object must be an image", "LIVE_PHOTO_INVALID_CONTENT_TYPE");
    }

    const updated = await livePhotoRepository.tryBeginProcessing(userId, s3Key);
    if (!updated) {
      const again = await livePhotoRepository.findByUserId(userId);
      if (again?.verificationState === "PROCESSING" && again.s3Key === s3Key) {
        return { status: "PROCESSING" };
      }
      throw new AppError(409, "Could not start verification", "LIVE_PHOTO_VERIFY_RACE");
    }

    await enqueueLivePhotoVerification({
      userId,
      s3Key,
      generation: updated.verifyGeneration,
      requestId,
    });

    await redisClient.set(
      RedisKeys.livePhotoVerifyStatus(userId),
      JSON.stringify({ state: "PROCESSING", at: Date.now(), generation: updated.verifyGeneration }),
      "EX",
      env.LIVE_PHOTO_VERIFY_STATUS_CACHE_TTL_SEC,
    );
    await bustLivePhotoCaches(userId);
    log.info({ userId, generation: updated.verifyGeneration, requestId }, "live_photo_verify_enqueued");
    return { status: "PROCESSING" };
  },

  async remove(userId: string): Promise<{ ok: true }> {
    const row = await livePhotoRepository.findByUserId(userId);
    const keysToPurge: string[] = [];
    if (row?.s3Key?.trim()) keysToPurge.push(row.s3Key.trim());
    if (row) {
      await livePhotoRepository.softReset(userId);
    }
    await bustLivePhotoCaches(userId);
    if (keysToPurge.length > 0) {
      await enqueueLivePhotoS3Purge(keysToPurge);
    }
    log.info({ userId }, "live_photo_removed");
    return { ok: true };
  },
};

export { bustLivePhotoCaches } from "./live-photo/live-photo-cache";
