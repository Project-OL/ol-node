-- Runs before `20260412082101_`, which alters `gift_galleries.updated_at`.
-- Original `gift_galleries` create (20260406182007) did not include this column.
ALTER TABLE "gift_galleries" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
