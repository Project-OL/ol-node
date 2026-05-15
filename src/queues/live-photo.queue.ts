import { createHash } from "crypto";
import { Queue } from "bullmq";
import { redisClient } from "../config/redis";
import {
  LIVE_PHOTO_S3_PURGE_JOB,
  LIVE_PHOTO_VERIFY_JOB,
  LIVE_PHOTO_VERIFY_QUEUE,
} from "./live-photo.constants";

const verifyJobOpts = {
  attempts: 6,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: 5000,
  removeOnFail: 5000,
};

const purgeJobOpts = {
  attempts: 4,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: 2000,
  removeOnFail: 2000,
};

export const livePhotoVerifyQueue = new Queue(LIVE_PHOTO_VERIFY_QUEUE, {
  connection: redisClient,
});

export type LivePhotoVerifyJobData = {
  userId: string;
  s3Key: string;
  generation: number;
  requestId?: string;
};

/** Stable BullMQ job id: same user+generation+object must dedupe; different `s3Key` must not collide after re-upload. */
export function buildLivePhotoVerifyJobId(data: LivePhotoVerifyJobData): string {
  const suffix = createHash("sha256")
    .update(`${data.userId}\0${data.generation}\0${data.s3Key}`)
    .digest("hex")
    .slice(0, 16);
  // BullMQ forbids ":" in custom job ids (Redis / internal rules).
  return `live-photo-${data.userId}-${data.generation}-${suffix}`;
}

export async function enqueueLivePhotoVerification(
  data: LivePhotoVerifyJobData,
): Promise<void> {
  await livePhotoVerifyQueue.add(LIVE_PHOTO_VERIFY_JOB, data, {
    ...verifyJobOpts,
    jobId: buildLivePhotoVerifyJobId(data),
  });
}

export async function enqueueLivePhotoS3Purge(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const purgeKey = createHash("sha256")
    .update(keys.join("\0"))
    .digest("hex")
    .slice(0, 16);
  await livePhotoVerifyQueue.add(
    LIVE_PHOTO_S3_PURGE_JOB,
    { keys },
    {
      ...purgeJobOpts,
      jobId: `live-photo-purge-${purgeKey}-${Date.now()}`,
    },
  );
}
