-- CreateEnum
CREATE TYPE "AdminStatus" AS ENUM ('ACTIVE', 'DISABLED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SupportTicketResolution" AS ENUM ('RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CsaNotificationType" AS ENUM ('TICKET_ASSIGNED', 'TICKET_REPLY', 'TICKET_REASSIGNED', 'TICKET_ESCALATED', 'REPORT_ASSIGNED');

-- CreateEnum
CREATE TYPE "ReportContext" AS ENUM ('CHAT', 'LIVE');

-- AlterTable: system_admins — CSA profile, status, failed-login tracking
ALTER TABLE "system_admins"
  ADD COLUMN "username" VARCHAR(50),
  ADD COLUMN "phone" VARCHAR(20),
  ADD COLUMN "phone_country_code" VARCHAR(8),
  ADD COLUMN "gender" VARCHAR(20),
  ADD COLUMN "country" VARCHAR(100),
  ADD COLUMN "status" "AdminStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_failed_login_at" TIMESTAMP(3),
  ADD COLUMN "locked_until" TIMESTAMP(3);

CREATE UNIQUE INDEX "system_admins_username_key" ON "system_admins"("username");

-- Backfill: keep status consistent with the pre-existing is_active flag
UPDATE "system_admins" SET "status" = 'DISABLED' WHERE "is_active" = false;

-- AlterTable: support_tickets — assignment, priority, resolution, SLA, transaction ref
ALTER TABLE "support_tickets"
  ADD COLUMN "assigned_admin_id" TEXT,
  ADD COLUMN "assigned_at" TIMESTAMP(3),
  ADD COLUMN "priority" "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN "resolution" "SupportTicketResolution",
  ADD COLUMN "resolved_at" TIMESTAMP(3),
  ADD COLUMN "first_response_at" TIMESTAMP(3),
  ADD COLUMN "ref_type" VARCHAR(40),
  ADD COLUMN "ref_id" VARCHAR(120);

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_admin_id_fkey"
  FOREIGN KEY ("assigned_admin_id") REFERENCES "system_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "support_tickets_assigned_admin_id_status_updated_at_idx" ON "support_tickets"("assigned_admin_id", "status", "updated_at");
CREATE INDEX "support_tickets_ref_type_ref_id_idx" ON "support_tickets"("ref_type", "ref_id");

-- CreateTable: support_ticket_notes (CSA-internal notes, never exposed on user endpoints)
CREATE TABLE "support_ticket_notes" (
    "id" BIGSERIAL NOT NULL,
    "ticket_id" BIGINT NOT NULL,
    "admin_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_ticket_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_ticket_notes_ticket_id_created_at_idx" ON "support_ticket_notes"("ticket_id", "created_at");

ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "support_ticket_notes_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket_notes" ADD CONSTRAINT "support_ticket_notes_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: csa_notifications (persistent — survive login)
CREATE TABLE "csa_notifications" (
    "id" BIGSERIAL NOT NULL,
    "admin_id" TEXT NOT NULL,
    "type" "CsaNotificationType" NOT NULL,
    "ticket_id" BIGINT,
    "report_id" TEXT,
    "message" VARCHAR(500) NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "csa_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "csa_notifications_admin_id_is_read_created_at_idx" ON "csa_notifications"("admin_id", "is_read", "created_at" DESC);

ALTER TABLE "csa_notifications" ADD CONSTRAINT "csa_notifications_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "system_admins"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "csa_notifications" ADD CONSTRAINT "csa_notifications_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: message_reports — chat/live context + admin review
ALTER TABLE "message_reports"
  ADD COLUMN "context" "ReportContext" NOT NULL DEFAULT 'CHAT',
  ADD COLUMN "live_session_id" TEXT,
  ADD COLUMN "host_user_id" UUID,
  ADD COLUMN "reviewed_by_admin_id" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "resolution_note" TEXT,
  ADD COLUMN "escalated_ticket_id" BIGINT;

ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_host_user_id_fkey"
  FOREIGN KEY ("host_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_reports" ADD CONSTRAINT "message_reports_reviewed_by_admin_id_fkey"
  FOREIGN KEY ("reviewed_by_admin_id") REFERENCES "system_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "message_reports_status_created_at_idx" ON "message_reports"("status", "created_at" DESC);
CREATE INDEX "message_reports_context_status_idx" ON "message_reports"("context", "status");
