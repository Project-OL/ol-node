-- Snapshot rail + who pays fiat; platform (EPAY) proof + waiting window on the withdrawal.
ALTER TABLE "withdrawals"
  ADD COLUMN IF NOT EXISTS "method_type" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "payout_handler" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "proof_s3_key" VARCHAR(500),
  ADD COLUMN IF NOT EXISTS "proof_s3_bucket" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "waiting_expires_at" TIMESTAMP(3);

UPDATE "withdrawals" w
SET
  "method_type" = COALESCE(pm."method_type", 'BANK'),
  "payout_handler" = CASE
    WHEN COALESCE(pm."method_type", 'BANK') = 'EPAY' THEN 'PLATFORM'
    ELSE 'AGENCY'
  END
FROM "user_payment_methods" pm
WHERE w."payment_method_id" = pm."id"
  AND (w."method_type" IS NULL OR w."payout_handler" IS NULL);

UPDATE "withdrawals"
SET
  "method_type" = COALESCE("method_type", 'BANK'),
  "payout_handler" = COALESCE("payout_handler", 'AGENCY')
WHERE "method_type" IS NULL OR "payout_handler" IS NULL;

CREATE INDEX IF NOT EXISTS "withdrawals_payout_handler_status_idx"
  ON "withdrawals"("payout_handler", "status");

CREATE INDEX IF NOT EXISTS "withdrawals_status_waiting_expires_at_idx"
  ON "withdrawals"("status", "waiting_expires_at");
