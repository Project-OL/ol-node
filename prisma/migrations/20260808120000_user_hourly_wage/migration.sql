-- Placeholder for future host hourly wage / salary feature.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "hourly_wage" BIGINT NOT NULL DEFAULT 0;
