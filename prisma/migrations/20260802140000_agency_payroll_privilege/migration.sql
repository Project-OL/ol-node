-- Admin-controlled payroll privilege (separate from agent accept toggle).
ALTER TABLE "agencies" ADD COLUMN IF NOT EXISTS "payroll_privilege_granted" BOOLEAN NOT NULL DEFAULT false;

-- Agencies already accepting payroll keep the privilege so they are not locked out.
UPDATE "agencies"
SET "payroll_privilege_granted" = true
WHERE "payroll_enabled" = true;

CREATE INDEX IF NOT EXISTS "agencies_payroll_privilege_granted_payroll_enabled_paused_at_idx"
  ON "agencies" ("payroll_privilege_granted", "payroll_enabled", "paused_at");
