-- Diamond buckets for the daily float snapshot.
--
-- Diamonds ride coin_ledger_entries, so their credits/debits were always inside
-- `ledger_net` while the wallet scan skipped DIAMOND wallets entirely. That made the
-- stock identity break by exactly the outstanding diamond stock — most visibly when an
-- admin seeded the GAME_HOUSE account. The scan now includes DIAMOND, and the snapshot
-- needs matching columns so a period-start float served from a snapshot agrees with a
-- live scan.
--
-- Existing rows default to 0. Snapshots written before this migration excluded diamonds
-- from `customer_total` / `house_total` too, so they stay internally consistent; only a
-- period whose opening snapshot predates any diamond activity could understate opening
-- float, and re-running the snapshot job for that day repairs it.

ALTER TABLE "ledger_float_snapshots"
  ADD COLUMN IF NOT EXISTS "customer_diamonds" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "house_diamonds" BIGINT NOT NULL DEFAULT 0;
