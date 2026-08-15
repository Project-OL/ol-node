-- Append-only admin/CSA failed-login history. Consecutive lockout counters
-- on system_admins still reset on success; these rows do not.
CREATE TYPE "AdminLoginFailureReason" AS ENUM ('INVALID_CREDENTIALS', 'ACCOUNT_LOCKED', 'ADMIN_IP_FORBIDDEN');

CREATE TABLE "admin_login_failures" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "reason" "AdminLoginFailureReason" NOT NULL,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_login_failures_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_login_failures_admin_id_created_at_idx" ON "admin_login_failures"("admin_id", "created_at" DESC);
CREATE INDEX "admin_login_failures_created_at_idx" ON "admin_login_failures"("created_at" DESC);

ALTER TABLE "admin_login_failures" ADD CONSTRAINT "admin_login_failures_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
