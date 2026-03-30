-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "device_fingerprint_hash" VARCHAR(64),
ADD COLUMN IF NOT EXISTS "ip_hash" VARCHAR(64),
ADD COLUMN IF NOT EXISTS "user_agent_hash" VARCHAR(64),
ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "token_version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "device_registry" ADD COLUMN IF NOT EXISTS "device_fingerprint_hash" VARCHAR(64),
ADD COLUMN IF NOT EXISTS "ip_hash" VARCHAR(64),
ADD COLUMN IF NOT EXISTS "user_agent_hash" VARCHAR(64);

-- Backfill updated_at for existing sessions
UPDATE "sessions" SET "updated_at" = "created_at" WHERE "updated_at" IS NULL;
