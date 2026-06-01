-- Agency dashboard read-path indexes.
--
-- NOTE on coverage: most indexes the dashboard relies on already exist and are
-- intentionally NOT duplicated here:
--   * agency_daily_earnings PRIMARY KEY (agency_user_id, host_user_id, day)
--       -> covers per-(agency,host,period) drilldown + the (agency_user_id, ...) prefix.
--   * agency_daily_earnings (agency_user_id, day DESC)   [existing @@index]
--       -> earnings overview + host summary period scans.
--   * agency_daily_earnings (host_user_id, day DESC)     [existing @@index]
--   * agency_hosts (agency_user_id, joined_at DESC)      [existing @@index]
--       -> totalHosts / newHosts roster counts.
--   * point_ledger_entries (wallet_id, tx_type, created_at DESC) [existing @@index]
--
-- The only genuinely new index is the wallet/tx-type/direction/created_at
-- composite that serves the agent's own-earnings and payroll-reward sums, which
-- additionally filter on `direction = 'CREDIT'`.
--
-- CREATE INDEX CONCURRENTLY is intentionally avoided: Prisma runs each migration
-- inside a transaction and CONCURRENTLY cannot run there. Use IF NOT EXISTS so the
-- migration is idempotent. For very large tables, build this index out-of-band
-- with CONCURRENTLY in a maintenance window and mark this migration as applied.

CREATE INDEX IF NOT EXISTS "point_ledger_entries_wallet_id_tx_type_direction_created_at_idx"
  ON "point_ledger_entries" ("wallet_id", "tx_type", "direction", "created_at");
