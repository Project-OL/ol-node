-- Seniority for payroll assignment: earliest accept-toggle enable time.
ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "payroll_enabled_at" TIMESTAMP(3);

-- Backfill: currently-enabled agencies use created_at as enable time.
UPDATE "agencies"
SET "payroll_enabled_at" = "created_at"
WHERE "payroll_enabled" = true AND "payroll_enabled_at" IS NULL;

CREATE INDEX IF NOT EXISTS "agencies_payroll_enabled_payroll_enabled_at_idx"
  ON "agencies"("payroll_enabled", "payroll_enabled_at");
