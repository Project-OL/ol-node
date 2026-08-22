-- Admin-configurable livestream daily reward window and per-hour points.
CREATE TABLE "livestream_reward_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "window_days" INTEGER NOT NULL DEFAULT 7,
    "points_per_hour" INTEGER NOT NULL DEFAULT 2500,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_admin_id" TEXT,

    CONSTRAINT "livestream_reward_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "livestream_reward_config" ("id", "window_days", "points_per_hour", "updated_at")
VALUES (1, 7, 2500, CURRENT_TIMESTAMP);
