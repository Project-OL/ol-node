-- CreateEnum
CREATE TYPE "UserRestrictionType" AS ENUM (
  'LIVE_CHAT_MUTE',
  'LIVE_AUDIO_MUTE',
  'MESSAGING_DISABLE',
  'LIVE_STREAM_START_BAN'
);

-- CreateTable
CREATE TABLE "user_restrictions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "UserRestrictionType" NOT NULL,
    "restricted_until" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "report_id" TEXT,
    "created_by_admin_id" TEXT NOT NULL,
    "cleared_at" TIMESTAMP(3),
    "cleared_by_admin_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_restrictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_restrictions_user_id_type_cleared_at_idx" ON "user_restrictions"("user_id", "type", "cleared_at");

-- CreateIndex
CREATE INDEX "user_restrictions_user_id_restricted_until_idx" ON "user_restrictions"("user_id", "restricted_until");

-- CreateIndex
CREATE INDEX "user_restrictions_report_id_idx" ON "user_restrictions"("report_id");

-- AddForeignKey
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_report_id_fkey" FOREIGN KEY ("report_id") REFERENCES "message_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;
