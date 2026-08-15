-- Singleton: admin/CSA login lockout (consecutive failures + duration).
CREATE TABLE "admin_auth_config" (
    "id" INTEGER NOT NULL,
    "failed_login_threshold" INTEGER NOT NULL DEFAULT 5,
    "lockout_minutes" INTEGER NOT NULL DEFAULT 1440,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "admin_auth_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "admin_auth_config" ("id", "failed_login_threshold", "lockout_minutes", "updated_at")
VALUES (1, 5, 1440, CURRENT_TIMESTAMP);
