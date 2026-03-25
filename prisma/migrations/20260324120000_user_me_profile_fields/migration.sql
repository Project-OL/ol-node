-- Profile fields for /me + display-name throttle
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bio" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "username_updated_at" TIMESTAMPTZ;

-- Longer URLs for CDN avatars
ALTER TABLE "users" ALTER COLUMN "avatar_url" TYPE TEXT;
