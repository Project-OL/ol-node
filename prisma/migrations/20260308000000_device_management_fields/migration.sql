-- AlterTable device_registry: add device management fields and composite unique
ALTER TABLE "device_registry" ADD COLUMN IF NOT EXISTS "platform" VARCHAR(20) NOT NULL DEFAULT 'web';
ALTER TABLE "device_registry" ADD COLUMN IF NOT EXISTS "login_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "device_registry" ADD COLUMN IF NOT EXISTS "ip_address" VARCHAR(45);
ALTER TABLE "device_registry" ADD COLUMN IF NOT EXISTS "user_agent" VARCHAR(500);

-- Drop old unique on device_id (one device could be used by multiple users)
DROP INDEX IF EXISTS "device_registry_device_id_key";

-- Composite unique: one row per user+device
CREATE UNIQUE INDEX IF NOT EXISTS "device_registry_user_id_device_id_key" ON "device_registry"("user_id", "device_id");

-- Index for listing by last active
CREATE INDEX IF NOT EXISTS "device_registry_user_id_last_active_at_idx" ON "device_registry"("user_id", "last_active_at" DESC);
