-- CreateEnum
CREATE TYPE "VipMembershipTier" AS ENUM ('DIAMOND', 'SVIP');

-- AlterEnum
ALTER TYPE "CoinTxType" ADD VALUE 'VIP_MEMBERSHIP_PURCHASE';

-- CreateTable
CREATE TABLE "vip_membership_purchases" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "tier" "VipMembershipTier" NOT NULL,
    "period_days" INTEGER NOT NULL,
    "coin_cost" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "expires_at_before" TIMESTAMP(3),
    "expires_at_after" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_membership_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_daily_claims" (
    "user_id" UUID NOT NULL,
    "claim_date" DATE NOT NULL,
    "coin_amount" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vip_daily_claims_pkey" PRIMARY KEY ("user_id","claim_date")
);

-- CreateTable
CREATE TABLE "vip_daily_quotas" (
    "user_id" UUID NOT NULL,
    "quota_date" DATE NOT NULL,
    "quota_type" VARCHAR(50) NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "max_allowed" INTEGER NOT NULL,

    CONSTRAINT "vip_daily_quotas_pkey" PRIMARY KEY ("user_id","quota_date","quota_type")
);

-- CreateIndex
CREATE UNIQUE INDEX "vip_membership_purchases_ledger_entry_id_key" ON "vip_membership_purchases"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "vip_membership_purchases_user_id_created_at_idx" ON "vip_membership_purchases"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "vip_membership_purchases_tier_created_at_idx" ON "vip_membership_purchases"("tier", "created_at" DESC);

-- CreateIndex
CREATE INDEX "vip_daily_claims_user_id_claim_date_idx" ON "vip_daily_claims"("user_id", "claim_date" DESC);

-- AddForeignKey
ALTER TABLE "vip_membership_purchases" ADD CONSTRAINT "vip_membership_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_membership_purchases" ADD CONSTRAINT "vip_membership_purchases_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_daily_claims" ADD CONSTRAINT "vip_daily_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_daily_claims" ADD CONSTRAINT "vip_daily_claims_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "coin_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_daily_quotas" ADD CONSTRAINT "vip_daily_quotas_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
