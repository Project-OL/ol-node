-- AlterTable
ALTER TABLE "users" ADD COLUMN "personal_coins_frozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "trading_coins_frozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "points_frozen" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "posting_suspended_until" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "posting_banned" BOOLEAN NOT NULL DEFAULT false;
