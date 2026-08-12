-- Singleton: support ticket PENDING_REVIEW contest / auto-close window (default 24h).
CREATE TABLE "support_config" (
    "id" INTEGER NOT NULL,
    "review_window_ms" INTEGER NOT NULL DEFAULT 86400000,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "support_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "support_config" ("id", "review_window_ms", "updated_at")
VALUES (1, 86400000, CURRENT_TIMESTAMP);
