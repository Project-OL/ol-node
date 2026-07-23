-- AlterEnum
ALTER TYPE "PointTxType" ADD VALUE 'LIVESTREAM_STREAK_REWARD';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "edited_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "livestream_reward_claims" (
    "user_id" UUID NOT NULL,
    "claim_date" DATE NOT NULL,
    "part" INTEGER NOT NULL,
    "points_amount" BIGINT NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "livestream_reward_claims_pkey" PRIMARY KEY ("user_id","claim_date","part")
);

-- CreateIndex
CREATE INDEX "livestream_reward_claims_user_id_claim_date_idx" ON "livestream_reward_claims"("user_id", "claim_date" DESC);

-- CreateIndex
CREATE INDEX "live_streams_user_id_started_at_idx" ON "live_streams"("user_id", "started_at");

-- AddForeignKey
ALTER TABLE "livestream_reward_claims" ADD CONSTRAINT "livestream_reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "livestream_reward_claims" ADD CONSTRAINT "livestream_reward_claims_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "point_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

