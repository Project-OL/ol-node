-- Agency ban: persist bar on user so they cannot re-apply after agency row is deleted.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agency_barred_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agency_barred_reason" TEXT;

-- Additive enum value for host exit history when admin bans an agency.
ALTER TYPE "AgencyHostHistoryReason" ADD VALUE IF NOT EXISTS 'AGENCY_BANNED';
