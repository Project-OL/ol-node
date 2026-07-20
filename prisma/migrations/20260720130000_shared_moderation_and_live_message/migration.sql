-- Shared-DB sync with livestream backend: LiveMessage (+ reply fields),
-- banned_words, live_stream_moderation_logs, video_call_moderation_logs.
-- Idempotent: legacy Neon tables may already exist without being in schema.prisma.

-- LiveMessage (PG table name is PascalCase — matches other backend; no @@map)
CREATE TABLE IF NOT EXISTS "LiveMessage" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reply_to_message_id" TEXT,
    "reply_to_user_id" TEXT,
    "reply_to_username" TEXT,
    "reply_to_text" TEXT,

    CONSTRAINT "LiveMessage_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "LiveMessage" ADD COLUMN IF NOT EXISTS "reply_to_message_id" TEXT;
ALTER TABLE "LiveMessage" ADD COLUMN IF NOT EXISTS "reply_to_user_id" TEXT;
ALTER TABLE "LiveMessage" ADD COLUMN IF NOT EXISTS "reply_to_username" TEXT;
ALTER TABLE "LiveMessage" ADD COLUMN IF NOT EXISTS "reply_to_text" TEXT;

CREATE TABLE IF NOT EXISTS "banned_words" (
    "id" UUID NOT NULL,
    "word" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "banned_words_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "banned_words_word_key" ON "banned_words"("word");

CREATE TABLE IF NOT EXISTS "live_stream_moderation_logs" (
    "id" UUID NOT NULL,
    "stream_id" TEXT NOT NULL,
    "detected_label" VARCHAR(255) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "s3_key" VARCHAR(512),
    "s3_bucket" VARCHAR(255),
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_stream_moderation_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "live_stream_moderation_logs_stream_id_idx"
    ON "live_stream_moderation_logs"("stream_id");

CREATE TABLE IF NOT EXISTS "video_call_moderation_logs" (
    "id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "detected_label" VARCHAR(255) NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "s3_key" VARCHAR(512),
    "s3_bucket" VARCHAR(255),
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_call_moderation_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "video_call_moderation_logs_session_id_idx"
    ON "video_call_moderation_logs"("session_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'video_call_moderation_logs_session_id_fkey'
    ) THEN
        ALTER TABLE "video_call_moderation_logs"
            ADD CONSTRAINT "video_call_moderation_logs_session_id_fkey"
            FOREIGN KEY ("session_id") REFERENCES "video_call_sessions"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
