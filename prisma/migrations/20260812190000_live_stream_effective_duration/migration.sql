-- Billable/effective live duration on host session rows (shared with livestream backend).
-- Backfill completed sessions from wall-clock ended_at − started_at.

ALTER TABLE "live_streams"
  ADD COLUMN IF NOT EXISTS "effective_duration_seconds" INTEGER NOT NULL DEFAULT 0;

UPDATE "live_streams"
SET "effective_duration_seconds" = GREATEST(
  0,
  FLOOR(EXTRACT(EPOCH FROM ("ended_at" - "started_at")))::integer
)
WHERE "ended_at" IS NOT NULL
  AND "started_at" IS NOT NULL
  AND "ended_at" > "started_at"
  AND "effective_duration_seconds" = 0;
