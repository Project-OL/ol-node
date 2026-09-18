-- Countries an admin may search/act on via the country-scoped user search page.
-- Zero rows for an admin = unrestricted (legacy behavior), same convention as
-- admin_view_assignments: 0 assignments = role-only gating, >=1 = restricted.
CREATE TABLE "admin_country_access" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "country" VARCHAR(100) NOT NULL,
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_country_access_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_country_access_admin_id_country_key"
    ON "admin_country_access"("admin_id", "country");
CREATE INDEX "admin_country_access_admin_id_idx" ON "admin_country_access"("admin_id");

ALTER TABLE "admin_country_access"
    ADD CONSTRAINT "admin_country_access_admin_id_fkey"
    FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fired whenever any admin applies LIVE_CHAT_MUTE / LIVE_AUDIO_MUTE /
-- MESSAGING_DISABLE or removes a profile picture — one row per SUPER_ADMIN
-- recipient (fan-out), same per-recipient polling shape as csa_notifications.
CREATE TYPE "ModerationNotificationType" AS ENUM (
  'LIVE_CHAT_MUTE',
  'LIVE_AUDIO_MUTE',
  'MESSAGING_DISABLE',
  'PROFILE_PICTURE_REMOVED'
);

CREATE TABLE "super_admin_notifications" (
    "id" UUID NOT NULL,
    "recipient_admin_id" TEXT NOT NULL,
    "action_type" "ModerationNotificationType" NOT NULL,
    "target_user_id" UUID NOT NULL,
    "reason" TEXT,
    "restricted_until" TIMESTAMP(3),
    "performed_by_admin_id" TEXT NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "super_admin_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "super_admin_notifications_recipient_admin_id_is_read_created_at_idx"
    ON "super_admin_notifications"("recipient_admin_id", "is_read", "created_at" DESC);
CREATE INDEX "super_admin_notifications_target_user_id_idx" ON "super_admin_notifications"("target_user_id");

ALTER TABLE "super_admin_notifications"
    ADD CONSTRAINT "super_admin_notifications_recipient_admin_id_fkey"
    FOREIGN KEY ("recipient_admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "super_admin_notifications"
    ADD CONSTRAINT "super_admin_notifications_target_user_id_fkey"
    FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
