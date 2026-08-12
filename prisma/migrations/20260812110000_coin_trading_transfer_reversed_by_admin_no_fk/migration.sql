-- Admin reverts store system_admins.id in reversed_by_user_id; drop the users FK.
ALTER TABLE "coin_trading_transfers"
  DROP CONSTRAINT IF EXISTS "coin_trading_transfers_reversed_by_user_id_fkey";
