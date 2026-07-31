-- Overnight wallet / VIP irregularity audit flags
CREATE TYPE "LedgerAuditCategory" AS ENUM ('VIP', 'COIN', 'POINT', 'TRADING_COIN');
CREATE TYPE "LedgerAuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "LedgerAuditStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'DISMISSED');

CREATE TABLE "ledger_audit_flags" (
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

CREATE UNIQUE INDEX "ledger_audit_flags_fingerprint_key" ON "ledger_audit_flags"("fingerprint");
CREATE INDEX "ledger_audit_flags_status_created_at_idx" ON "ledger_audit_flags"("status", "created_at" DESC);
CREATE INDEX "ledger_audit_flags_category_created_at_idx" ON "ledger_audit_flags"("category", "created_at" DESC);
CREATE INDEX "ledger_audit_flags_code_created_at_idx" ON "ledger_audit_flags"("code", "created_at" DESC);
CREATE INDEX "ledger_audit_flags_severity_created_at_idx" ON "ledger_audit_flags"("severity", "created_at" DESC);
CREATE INDEX "ledger_audit_flags_user_id_created_at_idx" ON "ledger_audit_flags"("user_id", "created_at" DESC);

ALTER TABLE "ledger_audit_flags" ADD CONSTRAINT "ledger_audit_flags_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
