-- Host live-stream session metadata (shared DB / livestream backend).
-- Idempotent: safe if a legacy "LiveStream" leftover already exists under another name.

CREATE TABLE IF NOT EXISTS "live_streams" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "heading" VARCHAR(100),
    "cover_image_url" TEXT,
    "stream_id" TEXT NOT NULL,
    "stream_key" TEXT NOT NULL,
    "playback_id" TEXT,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "live_streams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "live_streams_stream_id_key"
    ON "live_streams"("stream_id");

CREATE INDEX IF NOT EXISTS "live_streams_user_id_idx"
    ON "live_streams"("user_id");

CREATE INDEX IF NOT EXISTS "live_streams_is_live_idx"
    ON "live_streams"("is_live");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'live_streams_user_id_fkey'
    ) THEN
        ALTER TABLE "live_streams"
            ADD CONSTRAINT "live_streams_user_id_fkey"
            FOREIGN KEY ("user_id") REFERENCES "users"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
