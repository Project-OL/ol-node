-- DropIndex
DROP INDEX "device_registry_device_id_idx";

-- DropIndex
DROP INDEX "device_registry_user_id_last_active_at_idx";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "hide_mic_status" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "device_linked_accounts" (
    "id" TEXT NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "user_id" UUID NOT NULL,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_linked_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_deletions" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivation_until" TIMESTAMP(3) NOT NULL,
    "deletion_at" TIMESTAMP(3) NOT NULL,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelled_at" TIMESTAMP(3),
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "reason" VARCHAR(500),
    "ip_address" VARCHAR(45),

    CONSTRAINT "account_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "allow_msg_from_mutual" BOOLEAN NOT NULL DEFAULT true,
    "allow_msg_from_following" BOOLEAN NOT NULL DEFAULT true,
    "allow_msg_from_stranger" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_linked_accounts_device_id_idx" ON "device_linked_accounts"("device_id");

-- CreateIndex
CREATE INDEX "device_linked_accounts_user_id_idx" ON "device_linked_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_linked_accounts_device_id_user_id_key" ON "device_linked_accounts"("device_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_deletions_user_id_key" ON "account_deletions"("user_id");

-- CreateIndex
CREATE INDEX "account_deletions_scheduled_at_idx" ON "account_deletions"("scheduled_at");

-- CreateIndex
CREATE INDEX "account_deletions_deactivation_until_idx" ON "account_deletions"("deactivation_until");

-- CreateIndex
CREATE INDEX "account_deletions_deletion_at_idx" ON "account_deletions"("deletion_at");

-- CreateIndex
CREATE INDEX "account_deletions_is_deleted_idx" ON "account_deletions"("is_deleted");

-- CreateIndex
CREATE INDEX "account_deletions_user_id_idx" ON "account_deletions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- CreateIndex
CREATE INDEX "user_settings_user_id_idx" ON "user_settings"("user_id");

-- CreateIndex
CREATE INDEX "device_registry_user_id_last_active_at_idx" ON "device_registry"("user_id", "last_active_at");

-- AddForeignKey
ALTER TABLE "device_linked_accounts" ADD CONSTRAINT "device_linked_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
