-- Keep verified live photo visible while a replacement upload is pending/processing.
ALTER TABLE "user_live_photos" ADD COLUMN IF NOT EXISTS "pending_s3_key" TEXT;
ALTER TABLE "user_live_photos" ADD COLUMN IF NOT EXISTS "pending_s3_bucket" VARCHAR(255);
ALTER TABLE "user_live_photos" ADD COLUMN IF NOT EXISTS "replace_failed_reason" TEXT;
