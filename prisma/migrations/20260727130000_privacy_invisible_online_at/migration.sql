-- Frozen "last seen" timestamp when invisible-online is enabled (persists across VIP lapse/repurchase).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "privacy_invisible_online_at" TIMESTAMP(3);

-- Backfill for users who already enabled invisible online.
UPDATE "users"
SET "privacy_invisible_online_at" = "privacy_updated_at"
WHERE "privacy_invisible_online" = true
  AND "privacy_invisible_online_at" IS NULL
  AND "privacy_updated_at" IS NOT NULL;
