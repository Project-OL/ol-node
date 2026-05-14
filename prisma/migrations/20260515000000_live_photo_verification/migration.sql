-- CreateEnum
CREATE TYPE "LivePhotoVerificationState" AS ENUM (
  'NOT_UPLOADED',
  'PENDING_UPLOAD',
  'PENDING_VERIFICATION',
  'PROCESSING',
  'VERIFIED',
  'FAILED',
  'REJECTED'
);

-- CreateTable
CREATE TABLE "user_live_photos" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "s3_key" TEXT NOT NULL,
    "s3_bucket" VARCHAR(255) NOT NULL,
    "image_url" TEXT,
    "verification_state" "LivePhotoVerificationState" NOT NULL DEFAULT 'NOT_UPLOADED',
    "similarity_score" DOUBLE PRECISION,
    "verified_at" TIMESTAMP(3),
    "failed_reason" TEXT,
    "face_profile_id" UUID,
    "verify_generation" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_live_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "live_photo_verification_attempts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "live_photo_id" UUID NOT NULL,
    "similarity_score" DOUBLE PRECISION,
    "matched" BOOLEAN NOT NULL DEFAULT false,
    "rekognition_request_id" VARCHAR(128),
    "failure_reason" TEXT,
    "metadata" JSONB,
    "processing_latency_ms" INTEGER,
    "rekognition_latency_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_photo_verification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_live_photos_user_id_key" ON "user_live_photos"("user_id");

CREATE INDEX "user_live_photos_verification_state_idx" ON "user_live_photos"("verification_state");

CREATE INDEX "live_photo_verification_attempts_user_id_created_at_idx" ON "live_photo_verification_attempts"("user_id", "created_at" DESC);

CREATE INDEX "live_photo_verification_attempts_live_photo_id_created_at_idx" ON "live_photo_verification_attempts"("live_photo_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "user_live_photos" ADD CONSTRAINT "user_live_photos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_live_photos" ADD CONSTRAINT "user_live_photos_face_profile_id_fkey" FOREIGN KEY ("face_profile_id") REFERENCES "user_face_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "live_photo_verification_attempts" ADD CONSTRAINT "live_photo_verification_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "live_photo_verification_attempts" ADD CONSTRAINT "live_photo_verification_attempts_live_photo_id_fkey" FOREIGN KEY ("live_photo_id") REFERENCES "user_live_photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
