-- Per-rail enable/disable for bind + withdraw (default enabled).
ALTER TABLE "withdrawal_payout_rail_config"
  ADD COLUMN IF NOT EXISTS "epay_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "bank_enabled" BOOLEAN NOT NULL DEFAULT true;
