-- Phase 3b: payroll withdrawal, payment methods, SLA assignments

ALTER TYPE "PointTxType" ADD VALUE 'PAYROLL_PROCESSING_REWARD';

ALTER TYPE "WithdrawalStatus" ADD VALUE 'PENDING_PLATFORM';
ALTER TYPE "WithdrawalStatus" ADD VALUE 'DISPUTED';

CREATE TABLE "user_payment_methods" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "method_type" VARCHAR(10) NOT NULL,
    "epay_email" VARCHAR(255),
    "bank_name" VARCHAR(255),
    "bank_account_holder" VARCHAR(255),
    "bank_account_number" VARCHAR(50),
    "bank_ifsc_code" VARCHAR(20),
    "upi_number" VARCHAR(50),
    "registered_phone" VARCHAR(20),
    "registered_email" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_payment_methods_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_payment_methods_user_id_method_type_key" ON "user_payment_methods"("user_id", "method_type");
CREATE INDEX "user_payment_methods_user_id_idx" ON "user_payment_methods"("user_id");

ALTER TABLE "user_payment_methods" ADD CONSTRAINT "user_payment_methods_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "payroll_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "platform_fee_rate_bp" INTEGER NOT NULL DEFAULT 600,
    "agent_reward_rate_bp" INTEGER NOT NULL DEFAULT 300,
    "service_fee_usd" DECIMAL(8,2) NOT NULL DEFAULT 1.00,
    "min_withdrawal_usd" DECIMAL(12,2) NOT NULL DEFAULT 10.00,
    "max_withdrawal_usd" DECIMAL(18,2) NOT NULL DEFAULT 10000000.00,
    "sla_hours" INTEGER NOT NULL DEFAULT 2,
    "max_assignment_attempts" INTEGER NOT NULL DEFAULT 5,
    "inr_per_usd" DECIMAL(8,2) NOT NULL DEFAULT 88.00,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "payroll_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "payroll_config" ("id", "updated_at") VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "agencies" ADD COLUMN "last_payroll_assigned_at" TIMESTAMP(3);

CREATE INDEX "agencies_payroll_enabled_paused_at_last_payroll_assigned_at_idx" ON "agencies"("payroll_enabled", "paused_at", "last_payroll_assigned_at");

ALTER TABLE "withdrawals" ADD COLUMN "payment_method_id" UUID,
ADD COLUMN "host_payout_usd" DECIMAL(12,2),
ADD COLUMN "platform_fee_points" BIGINT,
ADD COLUMN "agent_reward_points" BIGINT,
ADD COLUMN "assignment_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "dispute_ticket_id" VARCHAR(255);

ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "user_payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "withdrawal_payroll_assignments" (
    "id" UUID NOT NULL,
    "withdrawal_id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "proof_s3_key" VARCHAR(500),
    "proof_s3_bucket" VARCHAR(255),
    "completed_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "assignment_number" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_payroll_assignments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "withdrawal_payroll_assignments_withdrawal_id_assignment_number_idx" ON "withdrawal_payroll_assignments"("withdrawal_id", "assignment_number");
CREATE INDEX "withdrawal_payroll_assignments_agency_user_id_status_assigned_at_idx" ON "withdrawal_payroll_assignments"("agency_user_id", "status", "assigned_at" DESC);
CREATE INDEX "withdrawal_payroll_assignments_status_expires_at_idx" ON "withdrawal_payroll_assignments"("status", "expires_at");

ALTER TABLE "withdrawal_payroll_assignments" ADD CONSTRAINT "withdrawal_payroll_assignments_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "withdrawal_payroll_assignments" ADD CONSTRAINT "withdrawal_payroll_assignments_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
