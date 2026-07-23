-- AlterTable
ALTER TABLE "users" ADD COLUMN "fcm_token" TEXT,
ADD COLUMN "fcm_token_updated_at" TIMESTAMP(3);
