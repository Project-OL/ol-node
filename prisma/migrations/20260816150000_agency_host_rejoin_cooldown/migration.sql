-- Admin-editable host rejoin cooldown (default 24 hours).
CREATE TABLE IF NOT EXISTS "agency_host_config" (
    "id" INTEGER NOT NULL,
    "rejoin_cooldown_hours" INTEGER NOT NULL DEFAULT 24,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_admin_id" UUID,

    CONSTRAINT "agency_host_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "agency_host_config" ("id", "rejoin_cooldown_hours", "updated_at")
VALUES (1, 24, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
