-- Admin actor on audit_logs (system_admins.id — no FK; same pattern as resolved_by_admin_id elsewhere).
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "admin_user_id" UUID;

CREATE INDEX IF NOT EXISTS "audit_logs_admin_user_id_idx" ON "audit_logs"("admin_user_id");

-- Backfill from legacy action_details.adminUserId where present.
UPDATE "audit_logs"
SET "admin_user_id" = ("action_details"->>'adminUserId')::uuid
WHERE "admin_user_id" IS NULL
  AND "action_details"->>'adminUserId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
