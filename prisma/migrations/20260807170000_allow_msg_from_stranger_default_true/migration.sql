-- Default: allow DMs from strangers for new users; backfill existing rows.
ALTER TABLE "user_settings"
  ALTER COLUMN "allow_msg_from_stranger" SET DEFAULT true;

UPDATE "user_settings"
SET "allow_msg_from_stranger" = true
WHERE "allow_msg_from_stranger" = false;
