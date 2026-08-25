-- Align `user_settings` with Live-server effect preference columns.
-- IF NOT EXISTS so envs that already applied Live-server DDL stay idempotent.

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "effect_top_runway" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "effect_gift" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "effect_lucky_gift" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "effect_entry" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "user_settings"
  ADD COLUMN IF NOT EXISTS "effect_global" BOOLEAN NOT NULL DEFAULT true;
