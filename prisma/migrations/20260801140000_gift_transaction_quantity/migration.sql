-- Combo gift quantity on gift_transactions (one ledger row per send; admin counts SUM(quantity)).
ALTER TABLE "gift_transactions" ADD COLUMN IF NOT EXISTS "quantity" INTEGER NOT NULL DEFAULT 1;

-- Backfill historical multi-sends where total coin_cost is an exact multiple of the catalog unit cost.
UPDATE "gift_transactions" AS gt
SET "quantity" = (gt."coin_cost" / g."coin_cost")
FROM "gifts" AS g
WHERE g."id" = gt."gift_id"
  AND g."coin_cost" > 0
  AND gt."coin_cost" > g."coin_cost"
  AND gt."coin_cost" % g."coin_cost" = 0;
