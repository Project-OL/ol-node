-- AlterEnum
ALTER TYPE "ReportReason" ADD VALUE 'GIFT_FRAUD';
ALTER TYPE "ReportReason" ADD VALUE 'MULTIPLE_ACCOUNT';
ALTER TYPE "ReportReason" ADD VALUE 'TOP_UP_FRAUD';
ALTER TYPE "ReportReason" ADD VALUE 'LIVE_BROADCAST_VIOLATION';
ALTER TYPE "ReportReason" ADD VALUE 'CHILD_SAFETY_VIOLATION';

-- AlterTable
ALTER TABLE "broadcast_reminders" ADD COLUMN     "notify_on_live" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "remind_at" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "broadcast_reminders_creator_id_notify_on_live_idx" ON "broadcast_reminders"("creator_id", "notify_on_live");
