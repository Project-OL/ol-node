-- Admin-editable account deletion windows (defaults: 30-day grace, 45-day delete).
CREATE TABLE IF NOT EXISTS "account_deletion_config" (
    "id" INTEGER NOT NULL,
    "grace_period_days" INTEGER NOT NULL DEFAULT 30,
    "deletion_period_days" INTEGER NOT NULL DEFAULT 45,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "account_deletion_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "account_deletion_config" ("id", "grace_period_days", "deletion_period_days", "updated_at")
VALUES (1, 30, 45, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "account_deletions" ADD COLUMN IF NOT EXISTS "reminder_sent_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "account_deletions_is_cancelled_is_deleted_deletion_at_idx"
ON "account_deletions"("is_cancelled", "is_deleted", "deletion_at");
