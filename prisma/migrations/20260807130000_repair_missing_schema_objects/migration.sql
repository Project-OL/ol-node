-- Repair: objects missing from DB even though older migrations are marked applied
-- in `_prisma_migrations`. Additive / idempotent only — no drops.

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260802120000_agency_bar_and_banned_reason (columns missing; enum exists)
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agency_barred_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "agency_barred_reason" TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260807010000_user_location_samples
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_latitude" DECIMAL(9,6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_longitude" DECIMAL(9,6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_location_accuracy_m" DOUBLE PRECISION;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_located_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "user_location_samples" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "accuracy_m" DOUBLE PRECISION,
    "source" VARCHAR(40) NOT NULL DEFAULT 'app_gps',
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_location_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "user_location_samples_user_id_recorded_at_idx"
  ON "user_location_samples"("user_id", "recorded_at" DESC);

CREATE INDEX IF NOT EXISTS "user_location_samples_recorded_at_idx"
  ON "user_location_samples"("recorded_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_location_samples_user_id_fkey') THEN
    ALTER TABLE "user_location_samples"
      ADD CONSTRAINT "user_location_samples_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260806090000_admin_ip_whitelist
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "admin_ip_whitelist" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "created_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_ip_whitelist_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_ip_whitelist_admin_id_ip_address_key"
  ON "admin_ip_whitelist"("admin_id", "ip_address");

CREATE INDEX IF NOT EXISTS "admin_ip_whitelist_admin_id_idx"
  ON "admin_ip_whitelist"("admin_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_ip_whitelist_admin_id_fkey') THEN
    ALTER TABLE "admin_ip_whitelist"
      ADD CONSTRAINT "admin_ip_whitelist_admin_id_fkey"
      FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260731120000_push_delivery_logs
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PushDeliveryStatus') THEN
    CREATE TYPE "PushDeliveryStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PushDeliverySource') THEN
    CREATE TYPE "PushDeliverySource" AS ENUM ('ADMIN_SINGLE', 'ADMIN_BROADCAST', 'TRANSACTION', 'NEW_MESSAGE');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "push_delivery_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "admin_user_id" UUID,
    "source" "PushDeliverySource" NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL,
    "campaign_id" VARCHAR(128),
    "title" VARCHAR(200) NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "data" JSONB,
    "error_code" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_delivery_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "push_delivery_logs_created_at_idx"
  ON "push_delivery_logs"("created_at" DESC);
CREATE INDEX IF NOT EXISTS "push_delivery_logs_status_created_at_idx"
  ON "push_delivery_logs"("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "push_delivery_logs_source_created_at_idx"
  ON "push_delivery_logs"("source", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "push_delivery_logs_user_id_created_at_idx"
  ON "push_delivery_logs"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "push_delivery_logs_campaign_id_idx"
  ON "push_delivery_logs"("campaign_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_delivery_logs_user_id_fkey') THEN
    ALTER TABLE "push_delivery_logs"
      ADD CONSTRAINT "push_delivery_logs_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260731220000_ledger_audit_flags
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerAuditCategory') THEN
    CREATE TYPE "LedgerAuditCategory" AS ENUM ('VIP', 'COIN', 'POINT', 'TRADING_COIN');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerAuditSeverity') THEN
    CREATE TYPE "LedgerAuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LedgerAuditStatus') THEN
    CREATE TYPE "LedgerAuditStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ledger_audit_flags" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "category" "LedgerAuditCategory" NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "severity" "LedgerAuditSeverity" NOT NULL,
    "status" "LedgerAuditStatus" NOT NULL DEFAULT 'OPEN',
    "fingerprint" VARCHAR(255) NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "ledger_entry_id" UUID,
    "point_ledger_entry_id" UUID,
    "vip_purchase_id" UUID,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by_admin_id" UUID,
    "resolution_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_audit_flags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_audit_flags_fingerprint_key"
  ON "ledger_audit_flags"("fingerprint");
CREATE INDEX IF NOT EXISTS "ledger_audit_flags_status_created_at_idx"
  ON "ledger_audit_flags"("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ledger_audit_flags_category_created_at_idx"
  ON "ledger_audit_flags"("category", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ledger_audit_flags_code_created_at_idx"
  ON "ledger_audit_flags"("code", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ledger_audit_flags_severity_created_at_idx"
  ON "ledger_audit_flags"("severity", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ledger_audit_flags_user_id_created_at_idx"
  ON "ledger_audit_flags"("user_id", "created_at" DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_audit_flags_user_id_fkey') THEN
    ALTER TABLE "ledger_audit_flags"
      ADD CONSTRAINT "ledger_audit_flags_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260722060000_message_edit_and_livestream_reward (claims table + index)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "livestream_reward_claims" (
    "user_id" UUID NOT NULL,
    "claim_date" DATE NOT NULL,
    "part" INTEGER NOT NULL,
    "points_amount" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "livestream_reward_claims_pkey" PRIMARY KEY ("user_id","claim_date","part")
);

CREATE INDEX IF NOT EXISTS "livestream_reward_claims_user_id_claim_date_idx"
  ON "livestream_reward_claims"("user_id", "claim_date" DESC);

CREATE INDEX IF NOT EXISTS "live_streams_user_id_started_at_idx"
  ON "live_streams"("user_id", "started_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'livestream_reward_claims_user_id_fkey') THEN
    ALTER TABLE "livestream_reward_claims"
      ADD CONSTRAINT "livestream_reward_claims_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'livestream_reward_claims_ledger_entry_id_fkey') THEN
    ALTER TABLE "livestream_reward_claims"
      ADD CONSTRAINT "livestream_reward_claims_ledger_entry_id_fkey"
      FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 20260802140000_agency_payroll_privilege (index missing)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS "agencies_payroll_privilege_granted_payroll_enabled_paused_at_idx"
  ON "agencies" ("payroll_privilege_granted", "payroll_enabled", "paused_at");

-- ═══════════════════════════════════════════════════════════════════════════
-- Missing FKs expected by schema (orphan-checked before apply)
-- ═══════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'withdrawals_user_id_fkey') THEN
    ALTER TABLE "withdrawals"
      ADD CONSTRAINT "withdrawals_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_restrictions_report_id_fkey') THEN
    ALTER TABLE "user_restrictions"
      ADD CONSTRAINT "user_restrictions_report_id_fkey"
      FOREIGN KEY ("report_id") REFERENCES "message_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
