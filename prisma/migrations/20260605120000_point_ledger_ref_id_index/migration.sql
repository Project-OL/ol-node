-- Index for GET /wallet/points/history/by-ref/:refId (wallet-scoped lookup).
CREATE INDEX IF NOT EXISTS "point_ledger_entries_wallet_id_ref_id_idx"
  ON "point_ledger_entries" ("wallet_id", "ref_id")
  WHERE "ref_id" IS NOT NULL;
