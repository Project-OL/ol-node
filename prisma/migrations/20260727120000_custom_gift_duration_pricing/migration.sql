-- Duration-based custom gift pricing (1 month / 3 months).
ALTER TABLE "custom_gift_config"
  ADD COLUMN IF NOT EXISTS "coin_cost_1_month" BIGINT NOT NULL DEFAULT 100000,
  ADD COLUMN IF NOT EXISTS "coin_cost_3_months" BIGINT NOT NULL DEFAULT 200000;

-- Backfill 1-month from legacy coin_cost when present.
UPDATE "custom_gift_config"
SET "coin_cost_1_month" = "coin_cost"
WHERE "coin_cost_1_month" = 100000 AND "coin_cost" <> 100000;
