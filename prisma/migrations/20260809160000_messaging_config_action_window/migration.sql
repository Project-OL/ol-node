-- Shared message edit/delete action window (default 1 hour).
CREATE TABLE IF NOT EXISTS "messaging_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "action_window_ms" INTEGER NOT NULL DEFAULT 3600000,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "messaging_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "messaging_config" ("id", "action_window_ms", "updated_at")
VALUES (1, 3600000, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
