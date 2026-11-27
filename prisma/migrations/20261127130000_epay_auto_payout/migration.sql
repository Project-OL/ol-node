-- Automatic Epay payouts (2026-11-27). Additive: one singleton table (OFF by default) and one
-- nullable column. Live-server maps user_payment_methods but not the new column (Prisma ignores
-- unknown columns), and never maps the new table.

CREATE TABLE "epay_auto_payout_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_single_payout_usd" DECIMAL(18,2) NOT NULL DEFAULT 5000.00,
    "user_daily_cap_usd" DECIMAL(18,2) NOT NULL DEFAULT 10000.00,
    "platform_daily_cap_usd" DECIMAL(18,2) NOT NULL DEFAULT 50000.00,
    "email_change_hold_hours" INTEGER NOT NULL DEFAULT 48,
    "min_balance_buffer_usd" DECIMAL(18,2) NOT NULL DEFAULT 0.00,
    "fee_reserve_usd" DECIMAL(18,2) NOT NULL DEFAULT 1.00,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_admin_id" VARCHAR(64),

    CONSTRAINT "epay_auto_payout_config_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "user_payment_methods" ADD COLUMN "epay_email_changed_at" TIMESTAMP(3);

-- Existing Epay binds: the last update is the latest moment the email could have changed
-- (conservative: never shortens the hold).
UPDATE "user_payment_methods"
SET "epay_email_changed_at" = "updated_at"
WHERE "method_type" = 'EPAY' AND "epay_email" IS NOT NULL;
