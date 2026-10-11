-- Admin-configurable required/format toggles for the BANK bind form (null = code defaults).
ALTER TABLE "withdrawal_payout_rail_config"
  ADD COLUMN IF NOT EXISTS "bank_field_rules" JSONB;
