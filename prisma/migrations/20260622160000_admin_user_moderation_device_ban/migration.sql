-- AlterEnum
ALTER TYPE "AgencyHostHistoryReason" ADD VALUE 'ADMIN_FORCE_EXIT';

-- CreateTable
CREATE TABLE "banned_devices" (
    "device_id" VARCHAR(255) NOT NULL,
    "reason" VARCHAR(500),
    "banned_by_admin_id" UUID,
    "related_user_id" UUID,
    "banned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banned_devices_pkey" PRIMARY KEY ("device_id")
);

-- CreateIndex
CREATE INDEX "banned_devices_related_user_id_idx" ON "banned_devices"("related_user_id");
