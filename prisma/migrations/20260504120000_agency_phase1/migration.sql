-- CreateEnum
CREATE TYPE "AgencyApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgencyLeaveApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'LATE_APPROVED', 'AUTO_APPROVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AgencyHostHistoryReason" AS ENUM ('LEAVE_APPROVED', 'LEAVE_AUTO_APPROVED', 'LEAVE_LATE_APPROVED', 'REMOVED_INACTIVE', 'REMOVED_SUSPENDED', 'CS_FORCE_EXIT', 'AGENT_DELETED', 'HOST_DELETED');

-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'AGENCY_FORCE_EXIT_PENALTY';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_agent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN     "last_active_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN     "current_agency_id" UUID;

-- CreateIndex
CREATE INDEX "users_is_agent_idx" ON "users"("is_agent");

-- CreateIndex
CREATE INDEX "users_current_agency_id_idx" ON "users"("current_agency_id");

-- CreateIndex
CREATE INDEX "users_last_active_at_idx" ON "users"("last_active_at");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_current_agency_id_fkey" FOREIGN KEY ("current_agency_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "agencies" (
    "user_id" UUID NOT NULL,
    "default_public_id" BIGINT NOT NULL,
    "display_name" VARCHAR(255) NOT NULL,
    "payroll_enabled" BOOLEAN NOT NULL DEFAULT false,
    "paused_at" TIMESTAMP(3),
    "paused_until" TIMESTAMP(3),
    "total_hosts_count" INTEGER NOT NULL DEFAULT 0,
    "lifetime_host_earnings_points" BIGINT NOT NULL DEFAULT 0,
    "current_level" VARCHAR(8) NOT NULL DEFAULT 'D',
    "current_window_total_points" BIGINT NOT NULL DEFAULT 0,
    "last_level_recomputed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agencies_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agencies_default_public_id_key" ON "agencies"("default_public_id");

-- CreateIndex
CREATE INDEX "agencies_payroll_enabled_paused_at_idx" ON "agencies"("payroll_enabled", "paused_at");

-- CreateIndex
CREATE INDEX "agencies_current_level_current_window_total_points_idx" ON "agencies"("current_level", "current_window_total_points" DESC);

-- CreateIndex
CREATE INDEX "agencies_total_hosts_count_idx" ON "agencies"("total_hosts_count" DESC);

-- AddForeignKey
ALTER TABLE "agencies" ADD CONSTRAINT "agencies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "agency_hosts" (
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agency_hosts_pkey" PRIMARY KEY ("host_user_id")
);

-- CreateIndex
CREATE INDEX "agency_hosts_agency_user_id_joined_at_idx" ON "agency_hosts"("agency_user_id", "joined_at" DESC);

-- AddForeignKey
ALTER TABLE "agency_hosts" ADD CONSTRAINT "agency_hosts_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_hosts" ADD CONSTRAINT "agency_hosts_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "agency_host_applications" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "status" "AgencyApplicationStatus" NOT NULL,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_host_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_host_applications_host_user_id_status_created_at_idx" ON "agency_host_applications"("host_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_host_applications_agency_user_id_status_created_at_idx" ON "agency_host_applications"("agency_user_id", "status", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "agency_host_applications" ADD CONSTRAINT "agency_host_applications_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_host_applications" ADD CONSTRAINT "agency_host_applications_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_host_applications" ADD CONSTRAINT "agency_host_applications_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique: at most one PENDING application per host
CREATE UNIQUE INDEX "agency_host_applications_one_pending_per_host" ON "agency_host_applications" ("host_user_id") WHERE status = 'PENDING';

-- CreateTable
CREATE TABLE "agency_leave_applications" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "status" "AgencyLeaveApplicationStatus" NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" UUID,
    "auto_approve_at" TIMESTAMP(3) NOT NULL,
    "late_approve_until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_leave_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_leave_applications_host_user_id_status_created_at_idx" ON "agency_leave_applications"("host_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_leave_applications_agency_user_id_status_created_at_idx" ON "agency_leave_applications"("agency_user_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "agency_leave_applications_status_auto_approve_at_idx" ON "agency_leave_applications"("status", "auto_approve_at");

-- AddForeignKey
ALTER TABLE "agency_leave_applications" ADD CONSTRAINT "agency_leave_applications_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_leave_applications" ADD CONSTRAINT "agency_leave_applications_host_user_id_fkey" FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agency_leave_applications" ADD CONSTRAINT "agency_leave_applications_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial unique: at most one PENDING leave application per host
CREATE UNIQUE INDEX "agency_leave_applications_one_pending_per_host" ON "agency_leave_applications" ("host_user_id") WHERE status = 'PENDING';

-- CreateTable
CREATE TABLE "agency_host_history" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "host_user_id" UUID NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL,
    "exited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" "AgencyHostHistoryReason" NOT NULL,
    "exit_metadata" JSONB,

    CONSTRAINT "agency_host_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agency_host_history_host_user_id_exited_at_idx" ON "agency_host_history"("host_user_id", "exited_at" DESC);

-- CreateIndex
CREATE INDEX "agency_host_history_agency_user_id_exited_at_idx" ON "agency_host_history"("agency_user_id", "exited_at" DESC);

-- Intentionally no FK from agency_host_history.agency_user_id → agencies: preserves audit rows when an agency row is removed.
