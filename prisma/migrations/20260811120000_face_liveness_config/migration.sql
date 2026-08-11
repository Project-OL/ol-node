-- Singleton Face Liveness gates (admin-toggleable; API also seeds from env on first getOrCreate).
CREATE TABLE IF NOT EXISTS "face_liveness_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "liveness_required" BOOLEAN NOT NULL DEFAULT false,
    "credentials_required" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "face_liveness_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "face_liveness_config" ("id", "liveness_required", "credentials_required", "updated_at")
VALUES (1, false, false, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
