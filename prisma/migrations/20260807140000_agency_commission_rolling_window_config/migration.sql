-- Singleton agency commission tier rolling-window config (days + hours + minutes).
CREATE TABLE "agency_commission_config" (
    "id" INTEGER NOT NULL,
    "window_days" INTEGER NOT NULL DEFAULT 30,
    "window_hours" INTEGER NOT NULL DEFAULT 0,
    "window_minutes" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" TEXT,

    CONSTRAINT "agency_commission_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "agency_commission_config" ("id", "window_days", "window_hours", "window_minutes", "updated_at")
VALUES (1, 30, 0, 0, CURRENT_TIMESTAMP);
