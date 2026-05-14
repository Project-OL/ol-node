/** BullMQ — async live photo CompareFaces verification (never blocks HTTP). */
export const LIVE_PHOTO_VERIFY_QUEUE = "live-photo-verify";

export const LIVE_PHOTO_VERIFY_JOB = "verify-live-photo";

/** Best-effort S3 object removal after soft-delete / replace. */
export const LIVE_PHOTO_S3_PURGE_JOB = "purge-live-photo-s3";
