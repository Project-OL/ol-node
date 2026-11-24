-- EPAY withdraw rail switched per audience. `epay_enabled` keeps its value and now
-- means "agents"; this new column covers everyone else and starts OFF (business rule).
ALTER TABLE "withdrawal_payout_rail_config"
  ADD COLUMN IF NOT EXISTS "epay_users_enabled" BOOLEAN NOT NULL DEFAULT false;
