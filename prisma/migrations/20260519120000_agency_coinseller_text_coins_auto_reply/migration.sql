-- CreateEnum
CREATE TYPE "AgencyTransferChannel" AS ENUM ('BANK', 'EPAY');

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'TEXT_COINS';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "is_auto_reply" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "agency_coinseller_settings" (
    "id" UUID NOT NULL,
    "agency_user_id" UUID NOT NULL,
    "transfer_channel" "AgencyTransferChannel" NOT NULL DEFAULT 'EPAY',
    "whatsapp_number" VARCHAR(30),
    "price_image_s3_key" VARCHAR(512),
    "price_image_s3_bucket" VARCHAR(128),
    "auto_reply" VARCHAR(100),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agency_coinseller_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agency_coinseller_settings_agency_user_id_key" ON "agency_coinseller_settings"("agency_user_id");

-- AddForeignKey
ALTER TABLE "agency_coinseller_settings" ADD CONSTRAINT "agency_coinseller_settings_agency_user_id_fkey" FOREIGN KEY ("agency_user_id") REFERENCES "agencies"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
