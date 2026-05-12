-- Additive messaging audio metadata (rolling deploy safe; existing rows get NONE processing + created_at = migration time).
-- Production follow-up: optionally backfill `created_at` from `messages.created_at` before relying on it for analytics.

CREATE TYPE "MediaProcessingStatus" AS ENUM ('NONE', 'PENDING', 'ENQUEUED', 'READY', 'FAILED');

CREATE TYPE "MediaTranscriptionStatus" AS ENUM ('NONE', 'PENDING', 'READY', 'FAILED');

ALTER TABLE "message_media" ADD COLUMN "waveform_json" JSONB,
ADD COLUMN "codec" VARCHAR(32),
ADD COLUMN "bitrate" INTEGER,
ADD COLUMN "sample_rate" INTEGER,
ADD COLUMN "channels" INTEGER,
ADD COLUMN "processing_status" "MediaProcessingStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN "transcription_status" "MediaTranscriptionStatus" NOT NULL DEFAULT 'NONE',
ADD COLUMN "checksum_sha256" VARCHAR(64),
ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "message_media_processing_status_created_at_idx" ON "message_media"("processing_status", "created_at");

CREATE INDEX "message_media_created_at_idx" ON "message_media"("created_at");
