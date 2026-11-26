-- EPAY-only minimum withdrawal (2026-11-26, management): $1,000 for USD and USDT alike,
-- configurable in admin. BANK keeps payroll_config.min_withdrawal_usd. Additive.
ALTER TABLE "withdrawal_payout_rail_config"
  ADD COLUMN "epay_min_withdrawal_usd" DECIMAL(18,2) NOT NULL DEFAULT 1000.00;
