-- DropForeignKey
ALTER TABLE "host_live_sessions" DROP CONSTRAINT IF EXISTS "host_live_sessions_host_user_id_fkey";

-- DropIndex
DROP INDEX IF EXISTS "agency_agent_applications_status_created_at_idx";

-- AlterTable
ALTER TABLE "agency_agent_applications" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "host_live_sessions" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "started_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "ended_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payroll_config" ALTER COLUMN "platform_fee_rate_bp" SET DEFAULT 500,
ALTER COLUMN "agent_reward_rate_bp" SET DEFAULT 6000,
ALTER COLUMN "inr_per_usd" SET DEFAULT 94.00;

-- AlterTable
ALTER TABLE "user_live_photos" ALTER COLUMN "verification_state" DROP DEFAULT;

-- AlterTable
ALTER TABLE "withdrawal_payout_rail_config" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "withdrawal_payroll_assignments" ALTER COLUMN "waiting_expires_at" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMP(3);

-- CreateIndex (replace partial index from 20260605120000 with full index per schema)
DROP INDEX IF EXISTS "point_ledger_entries_wallet_id_ref_id_idx";
CREATE INDEX IF NOT EXISTS "point_ledger_entries_wallet_id_ref_id_idx" ON "point_ledger_entries"("wallet_id", "ref_id");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'host_live_sessions_host_user_id_fkey'
  ) THEN
    ALTER TABLE "host_live_sessions" ADD CONSTRAINT "host_live_sessions_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RenameIndex (idempotent: only rename when source index still exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'gift_gallery_progress_host_user_id_gift_gallery_section_item_id') THEN
    ALTER INDEX "gift_gallery_progress_host_user_id_gift_gallery_section_item_id" RENAME TO "gift_gallery_progress_host_user_id_gift_gallery_section_ite_key";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_hls_agency_day') THEN
    ALTER INDEX "idx_hls_agency_day" RENAME TO "host_live_sessions_agency_user_id_started_at_idx";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_hls_host_status') THEN
    ALTER INDEX "idx_hls_host_status" RENAME TO "host_live_sessions_host_user_id_status_idx";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_payroll_assignments_agent_status_updated') THEN
    ALTER INDEX "idx_payroll_assignments_agent_status_updated" RENAME TO "withdrawal_payroll_assignments_agency_user_id_status_update_idx";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'withdrawal_payroll_assignments_agency_user_id_status_assigned_a') THEN
    ALTER INDEX "withdrawal_payroll_assignments_agency_user_id_status_assigned_a" RENAME TO "withdrawal_payroll_assignments_agency_user_id_status_assign_idx";
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'withdrawal_payroll_assignments_withdrawal_id_assignment_number_') THEN
    ALTER INDEX "withdrawal_payroll_assignments_withdrawal_id_assignment_number_" RENAME TO "withdrawal_payroll_assignments_withdrawal_id_assignment_num_idx";
  END IF;
END $$;
