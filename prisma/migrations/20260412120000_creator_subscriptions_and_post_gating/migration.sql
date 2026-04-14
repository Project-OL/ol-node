-- CreateEnum
CREATE TYPE "CreatorSubscriptionStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "CoinTxType" ADD VALUE 'CREATOR_SUBSCRIPTION';

-- AlterTable
ALTER TABLE "posts" ADD COLUMN "subscriber_only" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "creator_subscriptions" (
    "id" TEXT NOT NULL,
    "subscriber_id" UUID NOT NULL,
    "creator_id" UUID NOT NULL,
    "status" "CreatorSubscriptionStatus" NOT NULL,
    "next_renewal_at" TIMESTAMP(3) NOT NULL,
    "grace_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "creator_subscriptions_subscriber_id_creator_id_key" ON "creator_subscriptions"("subscriber_id", "creator_id");

CREATE INDEX "creator_subscriptions_next_renewal_at_status_idx" ON "creator_subscriptions"("next_renewal_at", "status");

ALTER TABLE "creator_subscriptions" ADD CONSTRAINT "creator_subscriptions_subscriber_id_fkey" FOREIGN KEY ("subscriber_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "creator_subscriptions" ADD CONSTRAINT "creator_subscriptions_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
