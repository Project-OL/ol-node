-- CreateTable: security_passwords (separate from login password; for purchases, destructive ops)
CREATE TABLE "security_passwords" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "set_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "failed_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_failed_attempt_at" TIMESTAMP(3),
    "locked_until" TIMESTAMP(3),

    CONSTRAINT "security_passwords_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "security_passwords_user_id_key" ON "security_passwords"("user_id");
CREATE INDEX "security_passwords_user_id_idx" ON "security_passwords"("user_id");
CREATE INDEX "security_passwords_locked_until_idx" ON "security_passwords"("locked_until");

-- Foreign key
ALTER TABLE "security_passwords" ADD CONSTRAINT "security_passwords_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
